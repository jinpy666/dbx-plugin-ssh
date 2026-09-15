#!/usr/bin/env python3
"""End-to-end smoke test for the fs/keys capability extensions (sftp_ext, sudo_fs, keys).

Reuses the connection flow from smoke_test.py: initialize -> connection/connect ->
connection/test (challenge auto-accepted) -> ssh/session/open, then exercises the
new backend methods against the test container. The new methods may not be
registered in main.rs yet; any "Method not found" answer is reported as SKIP so
the script passes both before and after wiring (only connection setup failures
or real method errors count as FAIL).

Usage:
    python3 scripts/smoke_fs_test.py                    # default test container
    python3 scripts/smoke_fs_test.py --host H --port P --user U --password W
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import struct
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError, lifecycle_params


def step(name: str):
    print(f"\n==> {name}")


class SkipSignal(Exception):
    """Raised by a case to skip itself for environmental reasons (e.g. an
    unstable container sudo configuration) without failing the run."""


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


def entry_kind(result: dict) -> str:
    """Entry kind across the plausible wire spellings ("?" when not reported)."""
    kind = result.get("kind") or result.get("fileType") or result.get("type")
    return str(kind) if kind else "?"


def mode_is_0700(value) -> bool:
    """Accept 0o700 in any plausible encoding: 448, "700", "0700", "rwx------"."""
    digits = str(value).strip().lstrip("-")
    if digits.isdigit():
        try:
            number = int(digits, 8)  # octal text like "700" / "0700"
        except ValueError:
            number = int(digits, 10)  # decimal like 448, or 0o100700-style ints
        return number & 0o777 == 0o700
    return "rwx------" in str(value)


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
        except Exception as error:
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
    # 本机落盘目录指向临时目录，避免污染开发者真实的 ~/Downloads；必须在
    # sidecar 启动前注入（sidecar 启动时读取一次环境变量）。
    download_dir = Path(tempfile.mkdtemp(prefix="dbx-ssh-smoke-downloads-"))
    os.environ["DBX_SSH_DOWNLOAD_DIR"] = str(download_dir)
    client = SidecarClient.start(timeout=30)
    try:
        step("plugin/initialize")
        info = client.initialize()
        print(json.dumps(info, ensure_ascii=False)[:200])

        connection_id = "smoke-fs-connection"
        workbench_id = "smoke-fs"
        connection = {
            "id": connection_id,
            "name": "smoke-fs",
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
        test_started = time.monotonic()
        result = client.request("connection/test", lifecycle_params(connection), timeout=90,
                                on_event=auto_accept_challenge)
        print(f"    test ok in {time.monotonic() - test_started:.1f}s: "
              f"{json.dumps(result, ensure_ascii=False)[:100]}")

        step("ssh/session/open")
        session = client.request("ssh/session/open",
                                 {"connectionId": connection_id, "workbenchId": workbench_id, "cols": 120, "rows": 30},
                                 timeout=60, on_event=auto_accept_challenge)
        session_id = session.get("sessionId", workbench_id)
        print(f"    session {session_id} opened")

        step("sftp/home")
        result = client.request("sftp/home", {"sessionId": session_id})
        home = result.get("path") or "/config"
        print(f"    home: {home}")

        # remote scratch paths used by the cases below
        ssh_dir = f"{home}/.ssh"
        touch_path = f"{home}/.dbx-fs-smoke-touch"
        write_path = f"{home}/.dbx-fs-smoke-write"
        archive_path = f"{home}/.dbx-parity-test.tar.gz"
        extract_dir = f"{home}/.dbx-parity-extract"
        sudo_dir = f"{home}/.sudo-test"
        sudo_file = f"{sudo_dir}/inner.txt"
        sudo_file_renamed = f"{sudo_dir}/inner-renamed.txt"

        def req(method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
            return client.request(method, params, timeout=timeout, on_event=auto_accept_challenge)

        # -- sftp_ext group ------------------------------------------------------

        def case_sftp_stat():
            stat = req("sftp/stat", {"sessionId": session_id, "path": home})
            print(f"    {home}: kind={entry_kind(stat)} size={stat.get('size')}")
            if entry_kind(stat) != "directory":
                raise AssertionError(f"{home} kind={entry_kind(stat)!r}, want 'directory'")

        def case_sftp_exists():
            present = req("sftp/exists", {"sessionId": session_id, "path": home})
            if present.get("exists") is not True:
                raise AssertionError(f"exists({home}) -> {json.dumps(present)[:120]}, want true")
            absent = req("sftp/exists", {"sessionId": session_id, "path": f"{home}/no-such-path-xyz"})
            if absent.get("exists") is not False:
                raise AssertionError(f"exists(missing) -> {json.dumps(absent)[:120]}, want false")
            print(f"    exists({home})=true, exists(no-such-path-xyz)=false")

        def case_sftp_touch_stat():
            req("sftp/touch", {"sessionId": session_id, "path": touch_path})
            stat = req("sftp/stat", {"sessionId": session_id, "path": touch_path})
            print(f"    {touch_path}: kind={entry_kind(stat)} size={stat.get('size')}")
            if entry_kind(stat) != "file" or stat.get("size") != 0:
                raise AssertionError(f"want empty file, got kind={entry_kind(stat)!r} size={stat.get('size')!r}")
            req("sftp/delete", {"sessionId": session_id, "path": touch_path})

        def case_sftp_write_read():
            payload = b"hello parity\n"
            req("sftp/write", {"sessionId": session_id, "remotePath": write_path,
                               "dataBase64": base64.b64encode(payload).decode()})
            read_back = client.request("sftp/read",
                                       {"sessionId": session_id, "path": write_path, "maxBytes": 4096})
            content = base64.b64decode(read_back.get("dataBase64", "")).decode(errors="replace")
            if content != payload.decode():
                raise AssertionError(f"read-back mismatch: {content!r}")
            print(f"    wrote and read back {write_path}")
            req("sftp/delete", {"sessionId": session_id, "path": write_path})

        def case_sftp_archive():
            try:  # archive source must exist; create ~/.ssh if the container lacks it
                req("sftp/createDirectory", {"sessionId": session_id, "path": ssh_dir})
            except SidecarError:
                pass
            # "paths" and "sourcePaths" are both sent: the wire name is not frozen yet
            req("sftp/archive", {"sessionId": session_id, "paths": [ssh_dir],
                                 "sourcePaths": [ssh_dir], "archivePath": archive_path})
            stat = req("sftp/stat", {"sessionId": session_id, "path": archive_path})
            size = stat.get("size")
            print(f"    {archive_path}: kind={entry_kind(stat)} size={size}")
            if not isinstance(size, (int, float)) or size <= 0:
                raise AssertionError(f"archive size={size!r}, want > 0")

        def case_sftp_extract():
            req("sftp/extract", {"sessionId": session_id, "archivePath": archive_path,
                                 "destinationPath": extract_dir})
            listing = client.request("sftp/list", {"sessionId": session_id, "path": home})
            name = extract_dir.rsplit("/", 1)[-1]
            entry = next((e for e in listing.get("entries", []) if e.get("name") == name), None)
            kind = entry_kind(entry or {})
            print(f"    extracted entry: {name} ({kind})")
            if entry is None:
                raise AssertionError(f"{extract_dir} missing from {home} listing")
            if kind not in ("directory", "?"):
                raise AssertionError(f"{extract_dir} kind={kind!r}, want directory")
            req("sftp/delete", {"sessionId": session_id, "path": extract_dir, "recursive": True})
            req("sftp/delete", {"sessionId": session_id, "path": archive_path})

        # -- sudo_fs group (container sshuser has NOPASSWD sudo) ------------------

        def case_sudo_stat():
            stat = req("sudo/stat", {"sessionId": session_id, "path": home})
            print(f"    {home}: kind={entry_kind(stat)} mode={stat.get('mode', stat.get('permissions'))}")
            if entry_kind(stat) != "directory":
                raise AssertionError(f"{home} kind={entry_kind(stat)!r}, want 'directory'")

        def case_sudo_exists():
            present = req("sudo/exists", {"sessionId": session_id, "path": home})
            if present.get("exists") is not True:
                raise AssertionError(f"exists({home}) -> {json.dumps(present)[:120]}, want true")
            absent = req("sudo/exists", {"sessionId": session_id, "path": f"{home}/no-such-path-xyz"})
            if absent.get("exists") is not False:
                raise AssertionError(f"exists(missing) -> {json.dumps(absent)[:120]}, want false")
            print(f"    exists({home})=true, exists(no-such-path-xyz)=false")

        def case_sudo_mkdir():
            req("sudo/mkdir", {"sessionId": session_id, "path": sudo_dir})
            print(f"    created {sudo_dir}")

        def case_sudo_touch():
            req("sudo/touch", {"sessionId": session_id, "path": sudo_file})
            stat = req("sudo/stat", {"sessionId": session_id, "path": sudo_file})
            print(f"    {sudo_file}: kind={entry_kind(stat)} size={stat.get('size')}")
            if entry_kind(stat) != "file":
                raise AssertionError(f"{sudo_file} kind={entry_kind(stat)!r}, want 'file'")

        def case_sudo_listdir():
            result = req("sudo/listDir", {"sessionId": session_id, "path": sudo_dir})
            names = [str(e.get("name")) for e in result.get("entries", [])]
            print(f"    {sudo_dir}: {names}")
            if sudo_file.rsplit("/", 1)[-1] not in names:
                raise AssertionError(f"inner file missing from listing: {names}")

        def case_sudo_write_read():
            payload = b"sudo parity\n"
            req("sudo/writeFile", {"sessionId": session_id, "path": sudo_file,
                               "dataBase64": base64.b64encode(payload).decode()})
            read_back = req("sudo/readFile", {"sessionId": session_id, "path": sudo_file, "maxBytes": 4096})
            content = base64.b64decode(read_back.get("dataBase64", "")).decode(errors="replace")
            if content != payload.decode():
                raise AssertionError(f"read-back mismatch: {content!r}")
            print(f"    wrote and read back {sudo_file}")

        def case_sudo_rename():
            req("sudo/rename", {"sessionId": session_id, "sourcePath": sudo_file,
                                "targetPath": sudo_file_renamed})
            print(f"    renamed to {sudo_file_renamed}")

        def case_sudo_chmod():
            req("sudo/chmod", {"sessionId": session_id, "path": sudo_file_renamed, "mode": "0700"})
            stat = req("sudo/stat", {"sessionId": session_id, "path": sudo_file_renamed})
            mode = stat.get("mode", stat.get("permissions"))
            print(f"    mode after chmod 0700: {mode}")
            if not mode_is_0700(mode):
                raise AssertionError(f"mode={mode!r}, want 0700")

        def case_sudo_remove_all():
            req("sudo/removeAll", {"sessionId": session_id, "path": sudo_dir})
            try:  # verify via sudo/exists when that method is wired too
                final = req("sudo/exists", {"sessionId": session_id, "path": sudo_dir})
                if final.get("exists") is not False:
                    raise AssertionError(f"{sudo_dir} still present after removeAll")
            except SidecarError as error:
                if missing_method(error) is None:
                    raise
            print(f"    removed {sudo_dir}")

        # -- quick sudo profiles group (local config store, session-less) -------

        profile_state: dict = {}
        # 测试专用密钥：运行时拼装，绝不使用真实凭据。
        profile_secret = f"smoke-{uuid.uuid4().hex}"

        def case_profiles_list_initial():
            result = req("sudo/profiles/list", {})
            if "profiles" not in result:
                raise AssertionError(f"missing profiles key: {json.dumps(result)[:160]}")
            print(f"    {len(result['profiles'])} profile(s) initially")

        def case_batch_bar_state_broadcast():
            # 纯广播方法：无 SSH 会话依赖，只要应答 Ok 即视为注册且可用。
            result = req("ssh/batchBar/state", {
                "source": "smoke-source",
                "draft": "echo smoke",
                "quickPickId": "",
                "open": True,
            })
            if result.get("broadcast") is not True:
                raise AssertionError(f"want broadcast=true: {json.dumps(result)[:160]}")

        def case_profiles_save_create():
            result = req("sudo/profiles/save", {
                "name": "smoke-ops",
                "sudoPassword": profile_secret,
                "totpSecret": "JBSWY3DPEHPK3PXP",
                "authFlowMode": "password_plus_otp",
                "sudoUsePty": True,
            })
            profile = result.get("profile") or {}
            profile_state["id"] = profile.get("id")
            if result.get("created") is not True:
                raise AssertionError(f"want created=true: {json.dumps(result)[:160]}")
            if profile.get("sudoPasswordSet") is not True or profile.get("totpConfigured") is not True:
                raise AssertionError(f"secret flags missing: {json.dumps(profile)[:160]}")
            if profile_secret in json.dumps(result):
                raise AssertionError("save response echoed the secret")

        def case_profiles_duplicate_name():
            error = None
            try:
                req("sudo/profiles/save", {"name": "SMOKE-OPS"})
            except SidecarError as raised:
                error = str(raised)
                if missing_method(raised) is not None:
                    raise
            if error is None:
                raise AssertionError("duplicate name was accepted")
            if "already in use" not in error:
                raise AssertionError(f"unexpected duplicate error: {error}")

        def case_profiles_update_keeps_secret():
            profile_id = profile_state.get("id")
            if not profile_id:
                raise AssertionError("no profile id from create case")
            result = req("sudo/profiles/save", {
                "id": profile_id,
                "name": "smoke-ops",
                "sudoPassword": "",
                "sudoUsePty": True,
            })
            profile = result.get("profile") or {}
            if profile.get("sudoPasswordSet") is not True:
                raise AssertionError("blank sudoPassword dropped the stored secret")
            if profile.get("sudoUsePty") is not True:
                raise AssertionError("sudoUsePty not updated")

        def case_profiles_list_hides_secrets():
            result = req("sudo/profiles/list", {})
            if profile_secret in json.dumps(result):
                raise AssertionError("list response echoed the secret")
            names = [profile.get("name") for profile in result.get("profiles") or []]
            if "smoke-ops" not in names:
                raise AssertionError(f"smoke-ops missing from list: {names}")

        def case_profiles_reveal():
            # 工作台专用回显：原值返回；list 视图仍保持 flag-only。
            profile_id = profile_state.get("id")
            if not profile_id:
                raise AssertionError("no profile id from create case")
            result = req("sudo/profiles/reveal", {"id": profile_id})
            profile = result.get("profile") or {}
            if profile.get("sudoPassword") != profile_secret:
                raise AssertionError(
                    f"reveal did not return the stored secret: {json.dumps(profile)[:160]}")
            if profile.get("totpSecret") != "JBSWY3DPEHPK3PXP":
                raise AssertionError("reveal did not return the stored TOTP secret")
            error = None
            try:
                req("sudo/profiles/reveal", {"id": "smoke-missing"})
            except SidecarError as raised:
                error = str(raised)
                if missing_method(raised) is not None:
                    raise
            if error is None:
                raise AssertionError("unknown profile id was accepted")
            list_result = req("sudo/profiles/list", {})
            if profile_secret in json.dumps(list_result):
                raise AssertionError("list still echoes the secret after reveal landed")
            print("    reveal returned the stored values; list stays flag-only")

        def case_profiles_options():
            result = req("sudo/profiles/options", {})
            options = result.get("options")
            if not isinstance(options, list):
                raise AssertionError(f"missing options list: {json.dumps(result)[:160]}")
            if profile_secret in json.dumps(result):
                raise AssertionError("options response echoed the secret")
            profile_id = profile_state.get("id")
            match = next((entry for entry in options if entry.get("value") == profile_id), None)
            if match is None:
                raise AssertionError(f"created profile missing from options: {json.dumps(result)[:200]}")
            if match.get("label") != "smoke-ops":
                raise AssertionError(f"option label mismatch: {json.dumps(match)}")
            print(f"    {len(options)} option(s) for the connection-form dropdown")

        def case_profiles_settings_binding():
            profile_id = profile_state.get("id")
            if not profile_id:
                raise AssertionError("no profile id from create case")
            bound = req("ssh/settings/set", {"sessionId": session_id, "quickSudoProfileId": profile_id})
            if bound.get("quickSudoProfileId") != profile_id:
                raise AssertionError(f"binding not reported: {json.dumps(bound)[:160]}")
            if bound.get("quickSudoProfileName") != "smoke-ops":
                raise AssertionError(f"binding name missing: {json.dumps(bound)[:160]}")
            cleared = req("ssh/settings/set", {"sessionId": session_id, "quickSudoProfileId": ""})
            if cleared.get("quickSudoProfileId"):
                raise AssertionError(f"binding not cleared: {json.dumps(cleared)[:160]}")

        def case_profiles_off_flow_and_reject():
            # 0.4.77：authFlowMode 新增 off（2FA 关闭）选项；未知值仍拒绝。
            # 测试专用密钥：运行时拼装，绝不使用真实凭据。
            off_secret = f"smoke-off-{uuid.uuid4().hex}"
            created = req("sudo/profiles/save", {
                "name": "smoke-ops-off",
                "sudoPassword": off_secret,
                "authFlowMode": "off",
            })
            profile = created.get("profile") or {}
            if created.get("created") is not True:
                raise AssertionError(f"want created=true: {json.dumps(created)[:160]}")
            if profile.get("authFlowMode") != "off":
                raise AssertionError(
                    f"off flow not persisted: {json.dumps(profile)[:160]}"
                )
            error = None
            try:
                req("sudo/profiles/save", {"name": "smoke-ops-bogus", "authFlowMode": "bogus"})
            except SidecarError as raised:
                error = str(raised)
                if missing_method(raised) is not None:
                    raise
            if error is None or "Unsupported authFlowMode" not in error:
                raise AssertionError(f"bogus flow not rejected: {error}")
            removed = req("sudo/profiles/delete", {"id": profile.get("id")})
            if removed.get("removed") is not True:
                raise AssertionError(f"cleanup delete failed: {json.dumps(removed)[:160]}")

        def case_profiles_delete():
            profile_id = profile_state.get("id")
            if not profile_id:
                raise AssertionError("no profile id from create case")
            removed = req("sudo/profiles/delete", {"id": profile_id})
            if removed.get("removed") is not True:
                raise AssertionError(f"want removed=true: {json.dumps(removed)[:160]}")
            again = req("sudo/profiles/delete", {"id": profile_id})
            if again.get("removed") is not False:
                raise AssertionError(f"repeat delete should be a no-op: {json.dumps(again)[:160]}")

        def case_connection_action_profiles():
            result = req("connection/action",
                         {"action": {"id": "quick-sudo-profiles"}, "id": connection_id})
            message = result.get("message") or ""
            if "smoke-ops" not in message:
                raise AssertionError(f"action message missing profile: {message[:200]}")
            if "uses its own sudo configuration" not in message:
                raise AssertionError(f"action message missing binding line: {message[:200]}")
            unknown = None
            try:
                req("connection/action", {"action": {"id": "no-such-action"}})
            except SidecarError as raised:
                unknown = str(raised)
                if missing_method(raised) is not None:
                    raise
            if unknown is None or "Unknown connection action" not in unknown:
                raise AssertionError(f"unknown action not rejected: {unknown}")

        # -- keys group ------------------------------------------------------------

        def case_keys_discover():
            result = req("keys/discover", {})
            keys = result.get("keys") or []
            print(f"    discovered {len(keys)} key(s)")
            for key in keys[:3]:
                fingerprint = str(key.get("fingerprint", ""))[:16]
                print(f"      - {key.get('path')} {key.get('algorithm', '')} fp={fingerprint}...")

        def case_keys_discover_options():
            # 连接表单 private_key_path 的 options_action 数据源：只出元数据，
            # 不出密钥材料。
            result = req("keys/discover/options", {})
            options = result.get("options") or []
            print(f"    {len(options)} key option(s)")
            for option in options[:3]:
                label = str(option.get("label", ""))
                value = str(option.get("value", ""))
                if not value or not label:
                    raise AssertionError(f"malformed option: {option}")
                if "PRIVATE KEY" in label:
                    raise AssertionError("key material leaked into option label")
                print(f"      - {label}")
                print(f"        {value}")

        def case_known_hosts():
            result = req("ssh/knownHosts/list", {})
            entries = result.get("entries") or []
            print(f"    {len(entries)} known-host entries")

        # -- agent terminal group ----------------------------------------------

        # A second registered connection with no open terminal session drives
        # the "no open terminal session" guidance error.
        agent_conn_id = "smoke-fs-agent-conn"
        agent_connection = dict(connection, id=agent_conn_id, name="smoke-fs-agent")

        def call_tool_embedded(tool: str, arguments: dict, connection_id: str = connection_id,
                               on_event=None, timeout: float = 90.0) -> dict:
            """Drive the DBX embedded bridge path (mcp/call + lifecycle).

            Tool results arrive MCP-style wrapped in content[0].text; tool
            errors surface as RPC errors (SidecarError) from mcp/call.
            """
            params = {
                "tool": tool,
                "arguments": arguments,
                "lifecycle": lifecycle_params(dict(agent_connection, id=connection_id,
                                                   name=connection_id)),
            }
            result = client.request("mcp/call", params, timeout=timeout, on_event=on_event)
            if result.get("isError"):
                raise SidecarError(str(result))
            return json.loads(result["content"][0]["text"])

        def approve_agent_prompt(event: dict) -> dict | None:
            if event.get("method") != "ssh/agent/prompt":
                return None
            params = event.get("params", {})
            print(f"    agent approval: risk={params.get('risk')} "
                  f"command={str(params.get('command'))[:60]!r}")
            return {"method": "ssh/agent/resolve",
                    "params": {"challengeId": params["challengeId"], "decision": "approve"}}

        def deny_agent_prompt(event: dict) -> dict | None:
            if event.get("method") != "ssh/agent/prompt":
                return None
            return {"method": "ssh/agent/resolve",
                    "params": {"challengeId": event["params"]["challengeId"],
                               "decision": "deny"}}

        def case_agent_mode_roundtrip():
            req("ssh/settings/set", {"sessionId": session_id, "agentTerminalMode": "auto"})
            got = req("ssh/settings/get", {"sessionId": session_id}).get("agentTerminalMode")
            if got != "auto":
                raise AssertionError(f"agentTerminalMode={got!r}, want 'auto'")

        def case_agent_mode_get_probe():
            # Connection-scoped probe consumed by the host bridge: the live
            # connection reports its mode plus session presence, while an
            # unknown id degrades to off/False instead of erroring.
            probe = req("ssh/agent/mode/get", {"connectionId": connection_id})
            if probe.get("agentTerminalMode") != "auto":
                raise AssertionError(f"probe mode={probe.get('agentTerminalMode')!r}, want 'auto'")
            if probe.get("hasTerminalSession") is not True:
                raise AssertionError(f"probe hasTerminalSession={probe.get('hasTerminalSession')!r}, want True")
            ghost = req("ssh/agent/mode/get", {"connectionId": "smoke-fs-ghost-conn"})
            if ghost.get("agentTerminalMode") != "off" or ghost.get("hasTerminalSession") is not False:
                raise AssertionError(f"ghost probe={ghost!r}, want off/False")

        def case_agent_no_session_error():
            try:
                call_tool_embedded("ssh_exec", {"command": "echo smoke", "runInTerminal": True},
                                   connection_id=agent_conn_id)
            except SidecarError as error:
                message = str(error)
                if "No open terminal session" not in message:
                    raise AssertionError(f"unexpected error: {message}")
                print(f"    guidance error ok: {message[:90]}")
                return
            raise AssertionError("terminal exec without a session unexpectedly succeeded")

        def case_agent_terminal_exec():
            marker = f"agent-terminal-ok-{int(time.time())}"
            result = call_tool_embedded("ssh_exec", {"command": f"echo {marker}"})
            if result.get("mode") != "terminal":
                raise AssertionError(f"mode={result.get('mode')!r}, want 'terminal'")
            if marker not in str(result.get("output", "")):
                raise AssertionError(f"output missing marker: {str(result.get('output'))[:200]}")
            if result.get("incomplete") is not False:
                raise AssertionError(f"incomplete={result.get('incomplete')!r}, want False")
            print(f"    routed output: {str(result.get('output'))[:80]!r}")

        def case_agent_strict_approval():
            req("ssh/settings/set", {"sessionId": session_id, "agentTerminalMode": "strict"})
            marker = f"agent-approved-{int(time.time())}"
            result = call_tool_embedded("ssh_exec", {"command": f"echo {marker}"},
                                        on_event=approve_agent_prompt)
            if marker not in str(result.get("output", "")):
                raise AssertionError(f"approved exec output missing marker: "
                                     f"{str(result.get('output'))[:200]}")

        def case_agent_deny():
            marker = f"agent-denied-{int(time.time())}"
            try:
                call_tool_embedded("ssh_exec", {"command": f"echo {marker}"},
                                   on_event=deny_agent_prompt)
            except SidecarError as error:
                if "denied" not in str(error):
                    raise AssertionError(f"unexpected deny error: {error}")
                print(f"    denied as expected: {str(error)[:80]}")
            else:
                raise AssertionError("denied command unexpectedly succeeded")
            finally:
                req("ssh/settings/set", {"sessionId": session_id, "agentTerminalMode": "off"})

        # -- 审批记忆 + 审计 + 告警分诊 group ------------------------------------
        # （docs/IMPL_PLAN_SSH_APPROVAL_AUDIT_ALERT.zh-CN.md §2）

        def remember_agent_prompt(event: dict) -> dict | None:
            # 批准并记住：把弹窗命令原样提交 + remember 标记。
            if event.get("method") != "ssh/agent/prompt":
                return None
            params = event.get("params", {})
            print(f"    agent approval (remember): risk={params.get('risk')} "
                  f"command={str(params.get('command'))[:60]!r}")
            return {"method": "ssh/agent/resolve",
                    "params": {"challengeId": params["challengeId"],
                               "decision": "approve",
                               "command": params.get("command"),
                               "remember": True}}

        def case_agent_remember_approval():
            # strict 模式 approve+remember：第一次弹审批并记住；同一命令第二次
            # 调用命中免审批清单 → 不带审批回调直接执行（若仍弹审批，调用会
            # 撞 90s 超时即失败）。
            marker_cmd = "echo smoke-remember-ok"
            req("ssh/settings/set", {"sessionId": session_id, "rememberedCommands": []})
            req("ssh/settings/set", {"sessionId": session_id, "agentTerminalMode": "strict"})
            first = call_tool_embedded("ssh_exec", {"command": marker_cmd},
                                       on_event=remember_agent_prompt)
            if "smoke-remember-ok" not in str(first.get("output", "")):
                raise AssertionError(f"first approved exec missing marker: "
                                     f"{str(first.get('output'))[:200]}")
            second = call_tool_embedded("ssh_exec", {"command": marker_cmd})
            if "smoke-remember-ok" not in str(second.get("output", "")):
                raise AssertionError(f"remembered exec missing marker: "
                                     f"{str(second.get('output'))[:200]}")
            print("    remembered command re-ran without an approval prompt")

        def case_agent_remember_listing_and_cleanup():
            got = req("ssh/settings/get", {"sessionId": session_id}).get("rememberedCommands")
            if not isinstance(got, list) or "echo smoke-remember-ok" not in got:
                raise AssertionError(f"rememberedCommands={got!r} missing remembered entry")
            # 全量替换语义：换一批通配形态的行。
            req("ssh/settings/set", {"sessionId": session_id,
                                     "rememberedCommands": ["echo a *", "echo b"]})
            got = req("ssh/settings/get", {"sessionId": session_id}).get("rememberedCommands")
            if got != ["echo a *", "echo b"]:
                raise AssertionError(f"rememberedCommands after replace={got!r}")
            # 破坏性行拒绝（IMPL_PLAN D2，错误信息带行号）。
            try:
                req("ssh/settings/set", {"sessionId": session_id,
                                         "rememberedCommands": ["echo ok", "rm -rf /"]})
            except SidecarError as error:
                if "destructive" not in str(error).lower():
                    raise AssertionError(f"unexpected destructive-line error: {error}")
                print(f"    destructive line refused: {str(error)[:90]}")
            else:
                raise AssertionError("destructive rememberedCommands line unexpectedly accepted")
            req("ssh/settings/set", {"sessionId": session_id, "rememberedCommands": []})

        def case_alert_triage():
            payload = json.dumps({
                "alertId": "smoke-1", "title": "CPU 使用率过高", "severity": "CRITICAL",
                "source": "prometheus", "message": "node-1 cpu_usage above 0.9",
                "data": {"instance": "node-1"},
            })
            result = req("ssh/alert/triage", {"payload": payload})
            normalized = result.get("normalized") or {}
            if normalized.get("alertId") != "smoke-1" or normalized.get("severity") != "critical":
                raise AssertionError(f"normalized={normalized!r}")
            if result.get("category") != "cpu":
                raise AssertionError(f"category={result.get('category')!r}, want 'cpu'")
            suggestions = result.get("suggestions") or []
            if not suggestions or not all(item.get("command") for item in suggestions):
                raise AssertionError(f"suggestions={suggestions!r}")
            if any("sudo" in str(item.get("command", "")) for item in suggestions):
                raise AssertionError(f"sudo leaked into playbook: {suggestions!r}")
            # 非 JSON 纯文本回退（整包作为 message）+ 双语分类。
            fallback = req("ssh/alert/triage", {"payload": "磁盘空间不足 disk full"})
            if fallback.get("category") != "disk":
                raise AssertionError(f"fallback category={fallback.get('category')!r}")
            if (fallback.get("normalized") or {}).get("message") != "磁盘空间不足 disk full":
                raise AssertionError(f"fallback normalized={fallback.get('normalized')!r}")
            print(f"    cpu suggestions={len(suggestions)}, fallback category=disk")

        def case_audit_list():
            result = req("ssh/audit/list", {"limit": 100})
            entries = result.get("entries") or []
            if not entries:
                raise AssertionError("audit ledger empty after prior tool calls")
            sample = entries[-1]
            for field in ("tsMs", "tool", "connectionId", "gate", "approval",
                          "outcome", "exitCode", "durationMs", "mode", "error"):
                if field not in sample:
                    raise AssertionError(f"audit entry missing {field}: {sample!r}")
            gates = {entry.get("gate") for entry in entries}
            approvals = {entry.get("approval") for entry in entries}
            if "pass" not in gates:
                raise AssertionError(f"no pass gate recorded: {gates!r}")
            if "remembered" not in approvals:
                raise AssertionError(f"remembered approval not audited: {approvals!r}")
            print(f"    {len(entries)} audit entries; gates={sorted(g for g in gates if g)}; "
                  f"approvals={sorted(a for a in approvals if a)}")

        # -- agent terminal extension group --------------------------------------
        # All routed commands below rely on agentTerminalMode=auto, re-armed by
        # case_agent_shell_state_reuse right after the deny case turned it off.

        # Ctrl-C goes straight into the session PTY exactly like the workbench
        # interrupt button (binary frames carry a u64 BE sequence prefix).
        input_seq = [0]

        def send_ctrl_c():
            input_seq[0] += 1
            client.send_binary(f"ssh/terminal/in/{session_id}",
                               struct.pack(">Q", input_seq[0]) + b"\x03")

        def call_tools_embedded_batch(entries: list[tuple[str, dict, str]],
                                      timeout: float = 90.0) -> list[dict]:
            """Fire several mcp/call requests through one pump (request_batch).

            entries: [(tool, arguments, connectionId), ...] — same envelope as
            call_tool_embedded, just batched so the calls overlap server-side.
            """
            specs = [{"method": "mcp/call",
                      "params": {"tool": tool, "arguments": arguments,
                                 "lifecycle": lifecycle_params(dict(agent_connection,
                                                                    id=conn, name=conn))},
                      "timeout": timeout}
                     for tool, arguments, conn in entries]
            return client.request_batch(specs, on_event=auto_accept_challenge)

        def tool_result(entry: dict, label: str) -> dict:
            """Unwrap one batch entry (an mcp/call result) like call_tool_embedded."""
            if "__error" in entry:
                raise AssertionError(f"{label} errored: {entry['__error']}")
            if entry.get("isError"):
                raise AssertionError(f"{label} failed: {str(entry)[:160]}")
            return json.loads(entry["content"][0]["text"])

        def case_agent_shell_state_reuse():
            # Connection reuse: the routed commands land in the SAME
            # interactive shell, so an export must survive across calls.
            req("ssh/settings/set", {"sessionId": session_id, "agentTerminalMode": "auto"})
            got = req("ssh/settings/get", {"sessionId": session_id}).get("agentTerminalMode")
            if got != "auto":
                raise AssertionError(f"agentTerminalMode={got!r}, want 'auto'")
            ts = int(time.time())
            call_tool_embedded("ssh_exec", {"command": f"export AGENT_SMOKE_TOKEN={ts}"})
            second = call_tool_embedded("ssh_exec", {"command": "echo $AGENT_SMOKE_TOKEN"})
            output = str(second.get("output", ""))
            if str(ts) not in output:
                raise AssertionError(f"shell state lost between calls: {output[:160]}")
            print(f"    token survived across calls: {output.strip()[:40]!r}")

        def case_agent_cwd_reuse():
            call_tool_embedded("ssh_exec", {"command": "cd /tmp && pwd"})
            second = call_tool_embedded("ssh_exec", {"command": "pwd"})
            output = str(second.get("output", ""))
            if "/tmp" not in output:
                raise AssertionError(f"cwd lost between calls: {output[:160]}")
            print(f"    cwd survived across calls: {output.strip()[:40]!r}")

        def case_agent_serialized_concurrent():
            # Two routed commands on the same session: the per-session exec
            # lock must serialize them (each capture free of the other's
            # markers) instead of interleaving keystrokes on one PTY.
            ts = int(time.time())
            entries = [
                ("ssh_exec", {"command": f"sleep 6 && echo AONLY-{ts}"}, connection_id),
                ("ssh_exec", {"command": f"echo BONLY-{ts}"}, connection_id),
            ]
            started = time.monotonic()
            results = call_tools_embedded_batch(entries, timeout=90.0)
            out_a = str(tool_result(results[0], "serialized A").get("output", ""))
            out_b = str(tool_result(results[1], "serialized B").get("output", ""))
            if f"AONLY-{ts}" not in out_a or f"BONLY-{ts}" in out_a:
                raise AssertionError(f"A capture polluted: {out_a[:160]!r}")
            if f"BONLY-{ts}" not in out_b or f"AONLY-{ts}" in out_b:
                raise AssertionError(f"B capture polluted: {out_b[:160]!r}")
            print(f"    serialized pair clean in {time.monotonic() - started:.1f}s")

        agent_session_state: dict = {}

        def case_open_agent_session():
            # Second live PTY on the agent connection for cross-connection
            # parallelism (the connection itself was opened earlier).
            session = req("ssh/session/open",
                          {"connectionId": agent_conn_id, "workbenchId": "smoke-fs-agent-wb",
                           "cols": 120, "rows": 30})
            agent_session_state["sessionId"] = session.get("sessionId", "smoke-fs-agent-wb")
            print(f"    agent session {agent_session_state['sessionId']} opened")

        def case_agent_parallel_cross_connection():
            # Different sessions (different connections) must run in parallel:
            # 2 x sleep 4 in ~4.5s; a serialized lock would need >= 8s.
            ts = int(time.time())
            entries = [
                ("ssh_exec", {"command": f"sleep 4 && echo P1-{ts}"}, connection_id),
                ("ssh_exec", {"command": f"sleep 4 && echo P2-{ts}"}, agent_conn_id),
            ]
            started = time.monotonic()
            results = call_tools_embedded_batch(entries, timeout=90.0)
            elapsed = time.monotonic() - started
            out_p1 = str(tool_result(results[0], "parallel P1").get("output", ""))
            out_p2 = str(tool_result(results[1], "parallel P2").get("output", ""))
            if f"P1-{ts}" not in out_p1:
                raise AssertionError(f"P1 output missing: {out_p1[:160]!r}")
            if f"P2-{ts}" not in out_p2:
                raise AssertionError(f"P2 output missing: {out_p2[:160]!r}")
            if elapsed >= 7.0:
                raise AssertionError(f"cross-connection calls took {elapsed:.1f}s "
                                     f"(serialized would be >= 8s; budget 7s)")
            print(f"    parallel pair ok in {elapsed:.1f}s (< 7s)")

        def case_agent_large_output_cap():
            # 2 MiB into the 1 MiB bounded recorder window: the head is
            # evicted, the capture stays valid and the response normal. The
            # trailing echo puts the fresh prompt on its own line, otherwise
            # the best-effort stripper would treat the whole (single-line)
            # capture as a prompt line and drop it.
            result = call_tool_embedded("ssh_exec",
                                        {"command": "head -c 2097152 /dev/zero | tr '\\0' x; echo"},
                                        timeout=120.0)
            output = str(result.get("output", ""))
            if not output.strip():
                raise AssertionError("empty output for a 2 MiB stream")
            if result.get("incomplete") is not False:
                raise AssertionError(f"incomplete={result.get('incomplete')!r}, want False")
            # Loose bound only (no exact-length assertion): a window that kept
            # everything would exceed the produced 2 MiB minus overhead.
            if len(output) > 1536 * 1024:
                raise AssertionError(f"capture not bounded: {len(output)} bytes")
            print(f"    captured {len(output)} bytes of the 2 MiB stream (bounded)")

        def case_agent_ansi_stripped():
            # The escape reaches the shell as printf text (sanitize only strips
            # raw control bytes from the injected command); the *captured
            # output* must come back ANSI-free.
            result = call_tool_embedded("ssh_exec",
                                        {"command": "printf '\\033[31mREDTEXT\\033[0m\\n'"})
            output = str(result.get("output", ""))
            if "REDTEXT" not in output:
                raise AssertionError(f"output missing REDTEXT: {output[:160]!r}")
            if "\x1b" in output:
                raise AssertionError("captured output still contains ESC bytes")
            print(f"    colored text captured clean: {output.strip()[:40]!r}")

        def case_agent_multiline_runs_line_by_line():
            # Known limitation, pinned here on purpose: a multi-line command
            # executes line by line, and both lines' output must be captured.
            result = call_tool_embedded("ssh_exec", {"command": "echo L1\necho L2"})
            output = str(result.get("output", ""))
            if "L1" not in output or "L2" not in output:
                raise AssertionError(f"multi-line output incomplete: {output[:160]!r}")
            print(f"    both lines executed: {output.strip()[:60]!r}")

        def case_agent_hidden_channel_opt_out():
            # runInTerminal:false in auto mode forces the audited hidden exec
            # channel, whose response carries no mode/incomplete fields.
            result = call_tool_embedded("ssh_exec",
                                        {"command": "echo legacy", "runInTerminal": False})
            if "legacy" not in str(result.get("output", "")):
                raise AssertionError(f"hidden exec output missing: {str(result)[:160]}")
            if "mode" in result:
                raise AssertionError(f"hidden-channel response leaks mode: {result}")
            print(f"    hidden channel: {str(result.get('output')).strip()[:40]!r}, no mode field")

        def case_agent_sudo_approval_chain():
            # Approval (elevated) -> terminal injection of `sudo whoami` -> the
            # terminal's auto-sudo state machine (or NOPASSWD sudo) answers ->
            # root. An unstable container sudo setup is SKIP, not FAIL.
            req("ssh/settings/set", {"sessionId": session_id, "sudoPassword": args.password})
            result = call_tool_embedded("ssh_exec_sudo",
                                        {"command": "whoami", "runInTerminal": True},
                                        on_event=approve_agent_prompt)
            output = str(result.get("output", ""))
            if "root" not in output:
                lowered = output.lower()
                if "sudo" in lowered and ("password" in lowered or "incorrect" in lowered
                                          or "not in the sudoers" in lowered):
                    raise SkipSignal(f"container sudo configuration unstable: {output[:120]}")
                raise AssertionError(f"sudo whoami output missing root: {output[:160]}")
            print(f"    sudo whoami -> {output.strip()[:40]!r}")

        def case_agent_timeout_incomplete_and_recover():
            # 5s budget against a 25s command: the AI gets partial output with
            # incomplete:true while the command keeps running; a Ctrl-C into
            # the PTY (as the workbench banner button does) clears it and the
            # shell takes new commands.
            result = call_tool_embedded("ssh_exec",
                                        {"command": "sleep 25", "timeoutSecs": 5,
                                         "runInTerminal": True})
            if result.get("incomplete") is not True:
                raise AssertionError(f"incomplete={result.get('incomplete')!r}, want True")
            send_ctrl_c()
            recovered = call_tool_embedded("ssh_exec", {"command": "echo recovered"})
            output = str(recovered.get("output", ""))
            if "recovered" not in output:
                raise AssertionError(f"shell not recovered after Ctrl-C: {output[:160]}")
            print("    incomplete reported, leftover sleep cleared, shell recovered")

        def case_agent_manual_interrupt():
            # Human-intervention semantics: a Ctrl-C typed into the terminal
            # (Timer thread writing the PTY input frame is thread-safe — only
            # the socket write races nothing) aborts the command early.
            ts = int(time.time())
            timer = threading.Timer(2.0, send_ctrl_c)
            timer.start()
            started = time.monotonic()
            try:
                result = call_tool_embedded("ssh_exec",
                                            {"command": f"sleep 20 && echo NOTDONE-{ts}"})
            finally:
                timer.cancel()
            elapsed = time.monotonic() - started
            output = str(result.get("output", ""))
            if f"NOTDONE-{ts}" in output:
                raise AssertionError("interrupted command still completed")
            if result.get("incomplete") is not False:
                raise AssertionError(f"incomplete={result.get('incomplete')!r}, want False")
            if elapsed >= 15.0:
                raise AssertionError(f"interrupted call took {elapsed:.1f}s (budget 15s)")
            print(f"    Ctrl-C returned in {elapsed:.1f}s without NOTDONE")

        def case_agent_settings_restored():
            restored = req("ssh/settings/set", {"sessionId": session_id,
                                                "agentTerminalMode": "off",
                                                "sudoPassword": ""})
            if restored.get("agentTerminalMode") != "off":
                raise AssertionError(f"agentTerminalMode={restored.get('agentTerminalMode')!r}, "
                                     "want 'off'")
            print("    agentTerminalMode=off, sudo password back to login fallback")


        report = Report()
        print("\n--- sftp_ext group ---")
        report.run("sftp/stat /config", "sftp/stat", case_sftp_stat)
        report.run("sftp/exists true/false", "sftp/exists", case_sftp_exists)
        report.run("sftp/touch + sftp/stat empty file", "sftp/touch", case_sftp_touch_stat)
        report.run("sftp/write + sftp/read round-trip", "sftp/write", case_sftp_write_read)
        archive_case = "sftp/archive .ssh -> tar.gz"
        report.run(archive_case, "sftp/archive", case_sftp_archive)
        report.run("sftp/extract tar.gz -> directory", "sftp/extract", case_sftp_extract, needs=archive_case)

        print("\n--- sudo_fs group ---")
        report.run("sudo/stat /config", "sudo/stat", case_sudo_stat)
        report.run("sudo/exists true/false", "sudo/exists", case_sudo_exists)
        report.run("sudo/mkdir .sudo-test", "sudo/mkdir", case_sudo_mkdir)
        report.run("sudo/touch inner file", "sudo/touch", case_sudo_touch,
                   needs="sudo/mkdir .sudo-test")
        report.run("sudo/listDir .sudo-test", "sudo/listDir", case_sudo_listdir,
                   needs="sudo/touch inner file")
        report.run("sudo/write + sudo/read round-trip", "sudo/writeFile", case_sudo_write_read,
                   needs="sudo/touch inner file")
        report.run("sudo/rename inner file", "sudo/rename", case_sudo_rename,
                   needs="sudo/touch inner file")
        report.run("sudo/chmod 0700 + verify mode", "sudo/chmod", case_sudo_chmod,
                   needs="sudo/rename inner file")
        report.run("sudo/removeAll .sudo-test", "sudo/removeAll", case_sudo_remove_all,
                   needs="sudo/mkdir .sudo-test")

        print("\n--- quick sudo profiles group ---")
        report.run("sudo/profiles/list initial", "sudo/profiles/list", case_profiles_list_initial)
        report.run("sudo/profiles/save create", "sudo/profiles/save", case_profiles_save_create)
        report.run("sudo/profiles/save duplicate name rejected", "sudo/profiles/save",
                   case_profiles_duplicate_name, needs="sudo/profiles/save create")
        report.run("sudo/profiles/save update keeps secret", "sudo/profiles/save",
                   case_profiles_update_keeps_secret, needs="sudo/profiles/save create")
        report.run("sudo/profiles/list hides secrets", "sudo/profiles/list",
                   case_profiles_list_hides_secrets, needs="sudo/profiles/save create")
        report.run("sudo/profiles/reveal returns stored secrets", "sudo/profiles/reveal",
                   case_profiles_reveal, needs="sudo/profiles/save create")
        report.run("sudo/profiles/options dropdown payload", "sudo/profiles/options",
                   case_profiles_options, needs="sudo/profiles/save create")
        report.run("ssh/settings binds profile", "ssh/settings/set",
                   case_profiles_settings_binding, needs="sudo/profiles/save create")
        report.run("connection/action quick-sudo-profiles", "connection/action",
                   case_connection_action_profiles, needs="sudo/profiles/save create")
        report.run("sudo/profiles/off flow accepted + bogus rejected", "sudo/profiles/save",
                   case_profiles_off_flow_and_reject)
        report.run("sudo/profiles/delete + repeat", "sudo/profiles/delete",
                   case_profiles_delete, needs="sudo/profiles/save create")

        print("\n--- keys group ---")
        report.run("ssh/batchBar/state broadcast", "ssh/batchBar/state", case_batch_bar_state_broadcast)
        report.run("keys/discover", "keys/discover", case_keys_discover)
        report.run("keys/discover/options", "keys/discover/options", case_keys_discover_options)
        report.run("ssh/knownHosts/list", "ssh/knownHosts/list", case_known_hosts)

        print("\n--- agent terminal group ---")
        report.run("agent mode settings round-trip", "ssh/settings/set", case_agent_mode_roundtrip)
        report.run("agent mode get probe", "ssh/agent/mode/get", case_agent_mode_get_probe,
                   needs="agent mode settings round-trip")
        report.run("connection/connect agent conn", "connection/connect",
                   lambda: req("connection/connect", lifecycle_params(agent_connection)))
        report.run("agent exec without session errors with guidance", "mcp/call",
                   case_agent_no_session_error, needs="connection/connect agent conn")
        report.run("agent terminal exec routes to PTY", "mcp/call", case_agent_terminal_exec,
                   needs="agent mode settings round-trip")
        report.run("agent strict approval approve", "mcp/call", case_agent_strict_approval,
                   needs="agent terminal exec routes to PTY")
        report.run("agent strict approval deny", "mcp/call", case_agent_deny,
                   needs="agent strict approval approve")
        report.run("agent approval remembered skips later prompts", "mcp/call",
                   case_agent_remember_approval, needs="agent strict approval deny")
        report.run("agent remembered list settings + destructive refused", "ssh/settings/set",
                   case_agent_remember_listing_and_cleanup,
                   needs="agent approval remembered skips later prompts")
        report.run("agent mode re-armed + shell state reused", "ssh/settings/set",
                   case_agent_shell_state_reuse,
                   needs="agent remembered list settings + destructive refused")
        report.run("agent cwd reused across calls", "mcp/call", case_agent_cwd_reuse,
                   needs="agent mode re-armed + shell state reused")
        report.run("agent same-session concurrency serialized", "mcp/call",
                   case_agent_serialized_concurrent,
                   needs="agent cwd reused across calls")
        report.run("agent second connection terminal opened", "ssh/session/open",
                   case_open_agent_session,
                   needs="agent mode re-armed + shell state reused")
        report.run("agent cross-connection parallelism", "mcp/call",
                   case_agent_parallel_cross_connection,
                   needs="agent second connection terminal opened")
        report.run("agent 2 MiB output stays bounded", "mcp/call",
                   case_agent_large_output_cap,
                   needs="agent same-session concurrency serialized")
        report.run("agent ANSI sequences stripped", "mcp/call", case_agent_ansi_stripped,
                   needs="agent 2 MiB output stays bounded")
        report.run("agent multi-line command runs line by line", "mcp/call",
                   case_agent_multiline_runs_line_by_line,
                   needs="agent ANSI sequences stripped")
        report.run("agent runInTerminal=false keeps hidden channel", "mcp/call",
                   case_agent_hidden_channel_opt_out,
                   needs="agent multi-line command runs line by line")
        report.run("agent sudo approval chain reaches root", "mcp/call",
                   case_agent_sudo_approval_chain,
                   needs="agent runInTerminal=false keeps hidden channel")
        report.run("agent timeout returns incomplete then recovers", "mcp/call",
                   case_agent_timeout_incomplete_and_recover,
                   needs="agent runInTerminal=false keeps hidden channel")
        report.run("agent manual Ctrl-C interrupt", "mcp/call", case_agent_manual_interrupt,
                   needs="agent timeout returns incomplete then recovers")
        report.run("agent settings restored (off + sudo password cleared)", "ssh/settings/set",
                   case_agent_settings_restored,
                   needs="agent mode re-armed + shell state reused")

        # -- F1/F2/F3 group: resume / processes / recording -----------------

        resume_src = f"{home}/.dbx-smoke-resume-src"

        def case_transfer_resumable_shape():
            result = req("sftp/transfer/resumable", {})
            tasks = result.get("tasks")
            if not isinstance(tasks, list):
                raise AssertionError(f"resumable -> {json.dumps(result)[:120]}, want tasks list")
            for task in tasks:
                for key in ("taskId", "remotePath", "fileName", "size", "resumableBytes"):
                    if key not in task:
                        raise AssertionError(f"resumable task missing {key}: {json.dumps(task)[:160]}")
            print(f"    resumable tasks: {len(tasks)}")

        def case_download_resume_offset():
            raw = b"resume-smoke-payload-19"
            payload = base64.b64encode(raw).decode()
            req("sftp/write", {"sessionId": session_id, "remotePath": resume_src, "dataBase64": payload})
            size = len(raw)
            # offset == size 合法：空传输直接可 finish。
            info = req("sftp/download/start", {"sessionId": session_id, "remotePath": resume_src, "offset": size})
            if info.get("resumeOffset") != size:
                raise AssertionError(f"resumeOffset={info.get('resumeOffset')!r}, want {size}")
            req("sftp/download/finish", {"taskId": info["taskId"]})
            # offset > size 拒绝。
            try:
                req("sftp/download/start", {"sessionId": session_id, "remotePath": resume_src, "offset": size + 1})
            except SidecarError as error:
                if "beyond" not in str(error):
                    raise AssertionError(f"unexpected resume error: {error}")
            else:
                raise AssertionError("offset beyond size accepted")
            print(f"    resume offset {size} accepted, {size + 1} refused")

        def case_upload_resume_rejects_unknown_task():
            try:
                req("sftp/upload/start", {"sessionId": session_id, "remotePath": resume_src,
                                          "size": 8, "resumeTaskId": "no-such-task"})
            except SidecarError as error:
                if "resumable" not in str(error).lower():
                    raise AssertionError(f"unexpected resume error: {error}")
            else:
                raise AssertionError("resume with unknown taskId accepted")

        def case_local_capabilities_shape():
            caps = req("local/capabilities")
            if not isinstance(caps.get("canSaveLocal"), bool):
                raise AssertionError(f"canSaveLocal missing: {json.dumps(caps)[:120]}")
            if not isinstance(caps.get("downloadsDir"), str) or not caps["downloadsDir"]:
                raise AssertionError(f"downloadsDir missing: {json.dumps(caps)[:120]}")
            if not isinstance(caps.get("platform"), str) or not caps["platform"]:
                raise AssertionError(f"platform missing: {json.dumps(caps)[:120]}")
            print(f"    canSaveLocal={caps['canSaveLocal']} dir={caps['downloadsDir']} platform={caps['platform']}")

        def case_local_sink_download_roundtrip():
            raw = b"local-sink-smoke-payload-2026"
            sink_src = f"{home}/.dbx-fs-smoke-sink"
            req("sftp/write", {"sessionId": session_id, "remotePath": sink_src,
                               "dataBase64": base64.b64encode(raw).decode()})
            # saveToLocal + offset 互斥（续传语义要求调用方持有前缀）。
            try:
                req("sftp/download/start", {"sessionId": session_id, "remotePath": sink_src,
                                            "offset": 1, "saveToLocal": True})
            except SidecarError as error:
                if "resume" not in str(error).lower():
                    raise AssertionError(f"unexpected sink+resume error: {error}")
            else:
                raise AssertionError("saveToLocal with resume offset accepted")
            info = req("sftp/download/start", {"sessionId": session_id, "remotePath": sink_src,
                                               "saveToLocal": True})
            if not info.get("saveToLocal"):
                raise AssertionError(f"saveToLocal not echoed: {json.dumps(info)[:120]}")
            task_id, size = info["taskId"], info["size"]
            assert size == len(raw), f"size {size} != {len(raw)}"
            offset = 0
            while True:
                result = req("sftp/download/next", {"taskId": task_id, "offset": offset})
                offset += result["length"]
                if result["eof"]:
                    break
                if offset >= size:
                    break
            finish = req("sftp/download/finish", {"taskId": task_id})
            local_path = finish.get("localPath")
            if not local_path:
                raise AssertionError(f"finish returned no localPath: {json.dumps(finish)[:160]}")
            saved = Path(local_path)
            if not saved.is_file() or saved.read_bytes() != raw:
                raise AssertionError(f"local file missing/mismatched: {local_path}")
            print(f"    saved {len(raw)} bytes -> {local_path}")
            # localPath 進歷史，才允許 reveal；任意路径必须被拒绝。
            history = req("sftp/transfer/history", {"limit": 50})
            row = next((t for t in history.get("tasks", []) if t.get("taskId") == task_id), None)
            if not row or row.get("localPath") != local_path or row.get("status") != "completed":
                raise AssertionError(f"history row missing localPath: {json.dumps(row)[:160]}")
            try:
                req("local/reveal", {"path": str(download_dir.parent / "not-recorded.txt")})
            except SidecarError as error:
                if "not saved by a completed download" not in str(error):
                    raise AssertionError(f"unexpected reveal error: {error}")
            else:
                raise AssertionError("local/reveal accepted an unrecorded path")
            print("    reveal refused unrecorded path")

        def case_local_sink_download_chunk_binary_frames():
            # 与 case_local_sink_download_roundtrip 分开的轻量校验：分块二进制帧
            # 仍按 [8B offset][data] 形状发出（前端兼容依赖）。
            raw = b"0123456789abcdef"
            src = f"{home}/.dbx-fs-smoke-sink2"
            req("sftp/write", {"sessionId": session_id, "remotePath": src,
                               "dataBase64": base64.b64encode(raw).decode()})
            info = req("sftp/download/start", {"sessionId": session_id, "remotePath": src,
                                               "saveToLocal": True})
            before = len(client.binary_frames)
            result = req("sftp/download/next", {"taskId": info["taskId"], "offset": 0})
            frames = [f for f in client.binary_frames[before:]
                      if f[0] == f"sftp/download/{info['taskId']}"]
            if not frames:
                raise AssertionError("no binary frame emitted for download chunk")
            channel, payload = frames[-1]
            (frame_offset,) = struct.unpack(">Q", payload[:8])
            if frame_offset != 0 or payload[8:] != raw[:result["length"]]:
                raise AssertionError(f"binary frame shape mismatch: offset={frame_offset}")
            req("sftp/download/finish", {"taskId": info["taskId"]})

        def case_processes_list_and_kill():
            listing = req("ssh/processes/list", {"sessionId": session_id}, timeout=30)
            processes = listing.get("processes")
            if not isinstance(processes, list) or not processes:
                raise AssertionError(f"processes/list -> {json.dumps(listing)[:160]}")
            row = processes[0]
            for key in ("pid", "ppid", "user", "cpuPercent", "memPercent", "command"):
                if key not in row:
                    raise AssertionError(f"process row missing {key}: {json.dumps(row)[:160]}")
            # pid 1 在后端校验层就被拒绝。
            try:
                req("ssh/processes/kill", {"sessionId": session_id, "pid": 1, "signal": 15})
            except SidecarError as error:
                if "Refusing" not in str(error):
                    raise AssertionError(f"unexpected pid-1 error: {error}")
            else:
                raise AssertionError("kill pid 1 accepted")
            # 起一个真实进程再终止，验证 kill 全链路。
            spawned = req("ssh/exec", {"sessionId": session_id,
                                       "command": "sleep 297 >/dev/null 2>&1 & echo $!"}, timeout=30)
            pid_text = (spawned.get("output") or "").strip().splitlines()[-1].strip() if spawned.get("output") else ""
            if not pid_text.isdigit():
                raise SkipSignal(f"could not spawn test process: {json.dumps(spawned)[:120]}")
            pid = int(pid_text)
            req("ssh/processes/kill", {"sessionId": session_id, "pid": pid, "signal": 15})
            time.sleep(0.5)
            check = req("ssh/exec", {"sessionId": session_id,
                                     "command": f"kill -0 {pid} 2>/dev/null; echo exit=$?"}, timeout=30)
            if "exit=0" in (check.get("output") or ""):
                raise AssertionError(f"pid {pid} still alive after SIGTERM")
            print(f"    listed {len(processes)} rows; spawned+terminated pid {pid}")

        def case_metrics_history():
            req("ssh/metrics", {"sessionId": session_id}, timeout=60)
            history = req("ssh/metrics/history", {"sessionId": session_id, "limit": 100}, timeout=30)
            samples = history.get("samples")
            if not isinstance(samples, list):
                raise AssertionError(f"metrics/history -> {json.dumps(history)[:160]}")
            if samples:
                row = samples[-1]
                for key in ("connectionId", "ts", "rxRate", "txRate"):
                    if key not in row:
                        raise AssertionError(f"sample missing {key}: {json.dumps(row)[:160]}")
            print(f"    history samples: {len(samples)}")

        def case_recording_flow():
            marker = f"smoke-rec-{uuid.uuid4().hex[:8]}"
            start = req("ssh/recording/start", {"sessionId": session_id})
            recording_id = start.get("recordingId")
            if not recording_id:
                raise AssertionError(f"recording/start -> {json.dumps(start)[:160]}")
            try:
                client.send_binary(f"ssh/terminal/in/{session_id}", struct.pack(">Q", 910) + f"echo {marker}\r".encode())
                time.sleep(2.0)
            finally:
                summary = req("ssh/recording/stop", {"sessionId": session_id})
            if summary.get("recordingId") != recording_id:
                raise AssertionError(f"stop -> {json.dumps(summary)[:160]}")
            listing = req("ssh/recording/list", {})
            if not any(item.get("recordingId") == recording_id for item in listing.get("recordings", [])):
                raise AssertionError(f"recording {recording_id} not listed: {json.dumps(listing)[:160]}")
            page = req("ssh/recording/get", {"recordingId": recording_id, "offset": 0, "limit": 500})
            blob = json.dumps(page.get("events", []), ensure_ascii=False)
            if marker not in blob:
                raise AssertionError(f"marker {marker} not captured in recording ({page.get('total')} events)")
            if page.get("hasMore"):
                raise AssertionError("unexpected hasMore with limit 500 and cap below page size")
            req("ssh/recording/delete", {"recordingId": recording_id})
            after = req("ssh/recording/list", {})
            if any(item.get("recordingId") == recording_id for item in after.get("recordings", [])):
                raise AssertionError(f"recording {recording_id} still listed after delete")
            print(f"    recorded {summary.get('events')} events, captured {marker}, deleted")

        def case_audit_clear():
            req("ssh/audit/clear", {})
            result = req("ssh/audit/list", {"limit": 100})
            if result.get("entries"):
                raise AssertionError(f"ledger not empty after clear: {result.get('entries')[:2]!r}")
            if result.get("truncated"):
                raise AssertionError("unexpected truncated after clear")
            # 新事件照常落账（clear 后新一代账本）：审计只记终端执行路径，
            # 普通 RPC 读操作与隐藏通道不产生条目——切 auto 模式跑一次低危
            # exec（终端直执 + 落账），验证完还原 off。
            req("ssh/settings/set", {"sessionId": session_id, "agentTerminalMode": "auto"})
            try:
                call_tool_embedded("ssh_exec", {"command": "echo audit-after-clear"})
            finally:
                req("ssh/settings/set", {"sessionId": session_id, "agentTerminalMode": "off"})
            after = req("ssh/audit/list", {"limit": 10})
            entries = after.get("entries") or []
            if not entries:
                raise AssertionError("audit ledger did not record after clear")
            # 执行行 wire shape 无 command 字段（协议刻意）；tool+mode+outcome
            # 足以证明是 clear 之后新落的执行条目。
            if not any(entry.get("tool") == "ssh_exec" and entry.get("mode") == "embedded"
                       and entry.get("outcome") == "ok" for entry in entries):
                raise AssertionError(f"no post-clear execution entry: {entries[:2]!r}")
            print("    cleared, then new entries recorded again")

        print("\n--- resume / processes / recording group ---")
        report.run("sftp/transfer/resumable shape", "sftp/transfer/resumable", case_transfer_resumable_shape)
        report.run("sftp download resume offset accepted/refused", "sftp/download/start",
                   case_download_resume_offset)
        report.run("sftp upload resume unknown task refused", "sftp/upload/start",
                   case_upload_resume_rejects_unknown_task)
        report.run("local/capabilities shape", "local/capabilities",
                   case_local_capabilities_shape)
        report.run("local sink download round-trip + reveal guard", "sftp/download/start",
                   case_local_sink_download_roundtrip)
        report.run("local sink download binary frame shape", "sftp/download/next",
                   case_local_sink_download_chunk_binary_frames)
        report.run("ssh/processes list + kill round-trip", "ssh/processes/list",
                   case_processes_list_and_kill)
        report.run("ssh/metrics/history samples", "ssh/metrics/history", case_metrics_history)
        report.run("ssh/recording start/stop/list/get/delete", "ssh/recording/start",
                   case_recording_flow)

        print("\n--- alert triage + audit group ---")
        report.run("ssh/alert/triage normalize+classify+playbook", "ssh/alert/triage",
                   case_alert_triage)
        report.run("ssh/audit/list returns approval trail", "ssh/audit/list",
                   case_audit_list,
                   needs="agent remembered list settings + destructive refused")
        report.run("ssh/audit/clear truncates the ledger", "ssh/audit/clear",
                   case_audit_clear,
                   needs="ssh/audit/list returns approval trail")

        step("cleanup leftovers")
        # Best-effort mode/secret restore even when a late case failed: the
        # sidecar keeps these in memory only, but a clean teardown keeps the
        # next smoke run's expectations honest.
        try:
            client.request("ssh/settings/set", {"sessionId": session_id,
                                                "agentTerminalMode": "off",
                                                "sudoPassword": ""})
        except SidecarError:
            pass
        for path, recursive in ((touch_path, False), (write_path, False), (resume_src, False),
                                (archive_path, False), (extract_dir, True), (sudo_dir, True),
                                (f"{home}/.dbx-fs-smoke-sink", False),
                                (f"{home}/.dbx-fs-smoke-sink2", False)):
            try:
                client.request("sftp/delete",
                               {"sessionId": session_id, "path": path, "recursive": recursive})
                print(f"    deleted {path}")
            except SidecarError:
                pass  # already cleaned by its case / not ours / needs sudo
        try:
            client.request("ssh/session/close", {"sessionId": session_id})
            print("    session closed")
        except SidecarError:
            pass
        agent_session_id = agent_session_state.get("sessionId")
        if agent_session_id:
            try:
                client.request("ssh/session/close", {"sessionId": agent_session_id})
                print("    agent session closed")
            except SidecarError:
                pass

        shutil.rmtree(download_dir, ignore_errors=True)
        client.close()
        step(f"summary ({time.monotonic() - started:.1f}s)")
        print(f"PASS {len(report.passed)} / SKIP {len(report.skipped)} / FAIL {len(report.failed)}")
        for name, reason in report.skipped:
            print(f"  SKIP {name}: {reason}")
        for name, error in report.failed:
            print(f"  FAIL {name}: {error}", file=sys.stderr)
        if report.failed:
            sys.exit(1)
        print("PASS: fs/keys smoke OK")
    except SidecarError as error:
        fail(str(error), client)
    except KeyboardInterrupt:
        client.close()


if __name__ == "__main__":
    main()
