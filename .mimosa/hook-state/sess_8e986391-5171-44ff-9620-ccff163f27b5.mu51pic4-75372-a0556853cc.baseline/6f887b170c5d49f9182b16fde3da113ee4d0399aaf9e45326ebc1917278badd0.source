#!/usr/bin/env python3
"""End-to-end smoke test for batch-3 capabilities: ssh/metrics network+processes
fields, sftp/copy and sftp/move semantics against a real SSH container.

Reuses the connection flow from smoke_fs_test.py: initialize -> connection/connect ->
connection/test (challenge auto-accepted) -> ssh/session/open. Cases marked SKIP on
"Method not found" so the script keeps passing against older sidecars.

Usage:
    DBX_PLUGIN_SIDECAR=backend/target/release/dbx-plugin-ssh-sftp \
        python3 scripts/smoke_batch3_test.py            # default test container
    python3 scripts/smoke_batch3_test.py --binary PATH --host H --port P --user U --password W
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError, lifecycle_params


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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default=None)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2222)
    parser.add_argument("--user", default="sshuser")
    parser.add_argument("--password", default="DbxTest2026")
    args = parser.parse_args()

    started = time.monotonic()
    # Isolated plugin data dir, pre-seeded with marked known_hosts lines so the
    # knownHosts roundtrip below is deterministic regardless of prior runs.
    data_dir = tempfile.mkdtemp(prefix="dbx-batch3-data-")
    key_line = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB1234567890abcdefghijklmnopqrstuvwxyz")
    (Path(data_dir) / "known_hosts").write_text(
        f"@cert-authority seeded.test {key_line} seeded-ca\n"
        f"@revoked revoked.test {key_line} seeded-revoked\n"
        f"seeded.test {key_line} seeded-plain\n"
    )
    client = SidecarClient.start(binary=args.binary, timeout=30, data_dir=data_dir)
    report = Report()
    scratch: list[tuple[str, bool]] = []
    connection_id = "smoke-batch3-connection"
    session_id = ""
    try:
        step("plugin/initialize")
        info = client.initialize()
        print(json.dumps(info, ensure_ascii=False)[:200])

        connection_id = "smoke-batch3-connection"
        workbench_id = "smoke-batch3"
        connection = {
            "id": connection_id,
            "name": "smoke-batch3",
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

        home = req("sftp/home", {"sessionId": session_id}).get("path") or "/config"
        print(f"    home: {home}")

        # sftp/copy keeps the source basename; targets live under their own dir.
        src_a = f"{home}/.dbx-batch3-a.txt"
        src_b = f"{home}/.dbx-batch3-b.txt"
        batch_dir = f"{home}/.dbx-batch3-dir"
        copied_a = f"{batch_dir}/.dbx-batch3-a.txt"
        copied_b = f"{batch_dir}/.dbx-batch3-b.txt"
        scratch = [(batch_dir, True), (src_a, False), (src_b, False)]

        def ensure_dir(path: str) -> None:
            present = req("sftp/exists", {"sessionId": session_id, "path": path})
            if present.get("exists") is not True:
                req("sftp/createDirectory", {"sessionId": session_id, "path": path})

        def ensure_gone(path: str) -> None:
            present = req("sftp/exists", {"sessionId": session_id, "path": path})
            if present.get("exists") is True:
                req("sftp/delete", {"sessionId": session_id, "path": path, "recursive": True})

        ensure_dir(batch_dir)
        ensure_gone(src_a)
        req("sftp/touch", {"sessionId": session_id, "path": src_a})

        # -- ssh/metrics batch-3 fields ---------------------------------------

        def case_metrics_network():
            metrics = req("ssh/metrics", {"sessionId": session_id}, timeout=90)
            network = metrics.get("network")
            if not isinstance(network, list) or not network:
                raise AssertionError(f"network missing/empty: {json.dumps(metrics)[:160]}")
            first = network[0]
            for field in ("name", "rxRate", "txRate", "rxTotal", "txTotal"):
                if field not in first:
                    raise AssertionError(f"network entry missing {field}: {json.dumps(first)[:160]}")
            print("    network: " + ", ".join(
                "{} rx={}B/s tx={}B/s".format(n.get("name"), n.get("rxRate"), n.get("txRate"))
                for n in network[:3]))

        def case_metrics_processes():
            metrics = req("ssh/metrics", {"sessionId": session_id}, timeout=90)
            processes = metrics.get("processes")
            if not isinstance(processes, list) or not processes:
                raise AssertionError(f"processes missing/empty: {json.dumps(metrics)[:160]}")
            first = processes[0]
            for field in ("pid", "user", "cpuPercent", "memPercent", "command"):
                if field not in first:
                    raise AssertionError(f"process entry missing {field}: {json.dumps(first)[:160]}")
            if len(processes) > 8:
                raise AssertionError(f"want at most 8 processes, got {len(processes)}")
            print(f"    top process: pid={first.get('pid')} {str(first.get('command'))[:60]}")

        def case_metrics_disk_inode_and_top_memory():
            metrics = req("ssh/metrics", {"sessionId": session_id}, timeout=90)
            top_memory = metrics.get("topMemory")
            if not isinstance(top_memory, list):
                raise AssertionError(f"topMemory missing: {json.dumps(metrics)[:160]}")
            for entry in top_memory:
                for field in ("pid", "user", "cpuPercent", "memPercent", "command"):
                    if field not in entry:
                        raise AssertionError(
                            f"topMemory entry missing {field}: {json.dumps(entry)[:160]}")
            disks = metrics.get("disks") or []
            with_inode = [d for d in disks if isinstance(d.get("inodeUsePercent"), (int, float))]
            if disks and not with_inode:
                raise AssertionError(f"no disk carries inodeUsePercent: {json.dumps(disks)[:200]}")
            print(f"    topMemory={len(top_memory)} rows; disks with inodeUsePercent: "
                  f"{len(with_inode)}/{len(disks)}")

        def case_metrics_cached():
            fresh = req("ssh/metrics", {"sessionId": session_id}, timeout=90)
            if fresh.get("cachedAt") is not None:
                raise AssertionError(f"fresh collection must not carry cachedAt: {json.dumps(fresh)[:160]}")
            cached = req("ssh/metrics", {"sessionId": session_id, "cached": True}, timeout=30)
            cached_at = cached.get("cachedAt")
            if not isinstance(cached_at, (int, float)) or cached_at <= 0:
                raise AssertionError(f"cached read missing cachedAt: {json.dumps(cached)[:160]}")
            if cached.get("hostname") != fresh.get("hostname"):
                raise AssertionError("cached snapshot is not the previous sample")
            print(f"    cachedAt={cached_at}")

        report.run("ssh/metrics reports network interfaces", "ssh/metrics", case_metrics_network)
        report.run("ssh/metrics reports top processes", "ssh/metrics", case_metrics_processes,
                   needs="ssh/metrics reports network interfaces")
        report.run("ssh/metrics reports inode usage and top memory processes", "ssh/metrics",
                   case_metrics_disk_inode_and_top_memory,
                   needs="ssh/metrics reports top processes")
        report.run("ssh/metrics serves the cached snapshot", "ssh/metrics", case_metrics_cached,
                   needs="ssh/metrics reports network interfaces")

        # -- sftp/read offset paging -------------------------------------------

        read_target = f"{home}/.dbx-batch3-read.bin"
        scratch.append((read_target, False))

        def case_sftp_read_offset():
            content = b"0123456789abcdef" * 16  # 256 bytes
            req("sftp/write", {"sessionId": session_id, "remotePath": read_target,
                               "dataBase64": base64.b64encode(content).decode()})
            head = req("sftp/read", {"sessionId": session_id, "path": read_target,
                                     "maxBytes": 16})
            head_data = base64.b64decode(head.get("dataBase64", ""))
            if head_data != content[:16] or head.get("truncated") is not True:
                raise AssertionError(f"head read wrong: truncated={head.get('truncated')!r}")
            tail = req("sftp/read", {"sessionId": session_id, "path": read_target,
                                     "offset": 16, "maxBytes": 256 * 1024})
            tail_data = base64.b64decode(tail.get("dataBase64", ""))
            if tail_data != content[16:] or tail.get("truncated") is not False:
                raise AssertionError(f"offset read wrong: truncated={tail.get('truncated')!r}")
            eof = req("sftp/read", {"sessionId": session_id, "path": read_target,
                                    "offset": 10_000_000})
            eof_data = base64.b64decode(eof.get("dataBase64", ""))
            if eof_data != b"" or eof.get("truncated") is not False:
                raise AssertionError(f"EOF offset read wrong: {json.dumps(eof)[:120]}")
            print("    head(maxBytes)/offset/eof reads ok")

        report.run("sftp/read honors offset paging", "sftp/read", case_sftp_read_offset)

        # -- ssh/sessions/list -------------------------------------------------

        def case_sessions_list():
            payload = req("ssh/sessions/list", {}, timeout=30)
            sessions = payload.get("sessions")
            if not isinstance(sessions, list) or not sessions:
                raise AssertionError(f"sessions missing/empty: {json.dumps(payload)[:200]}")
            mine = next((s for s in sessions if s.get("sessionId") == session_id), None)
            if mine is None:
                raise AssertionError("current session missing from the inventory")
            for field in ("sessionId", "connectionId", "workbenchId", "readOnly",
                          "connected", "sudoKeepalive", "createdAt", "authMethod"):
                if field not in mine:
                    raise AssertionError(f"session row missing {field}: {json.dumps(mine)[:160]}")
            if mine.get("connected") is not True:
                raise AssertionError(f"current session not connected: {json.dumps(mine)[:160]}")
            if not isinstance(mine.get("createdAt"), int) or mine.get("createdAt") <= 0:
                raise AssertionError(f"createdAt must be unix seconds: {json.dumps(mine)[:160]}")
            auth_method = mine.get("authMethod")
            known = ("password", "private-key", "private-key-password", "agent", "none")
            if auth_method not in known:
                raise AssertionError(f"authMethod must be a known method name, got {auth_method!r}: {json.dumps(mine)[:160]}")
            print(f"    {len(sessions)} session(s); current readOnly={mine.get('readOnly')} authMethod={auth_method}")

        # -- ssh/knownHosts marker entries -------------------------------------

        def case_known_hosts_markers():
            listed = req("ssh/knownHosts/list", {}, timeout=30)
            entries = listed.get("entries")
            if not isinstance(entries, list):
                raise AssertionError(f"entries missing: {json.dumps(listed)[:160]}")
            by_host = {}
            for entry in entries:
                if "marker" not in entry:
                    raise AssertionError(f"entry missing marker field: {json.dumps(entry)[:160]}")
                by_host.setdefault(entry.get("host"), []).append(entry)
            marked = by_host.get("seeded.test") or []
            ca = next((e for e in marked if e.get("marker") == "@cert-authority"), None)
            plain = next((e for e in marked if e.get("marker") is None), None)
            if ca is None or plain is None:
                raise AssertionError(f"seeded marker/plain entries missing: {json.dumps(entries)[:300]}")
            revoked = by_host.get("revoked.test") or []
            if not revoked or revoked[0].get("marker") != "@revoked":
                raise AssertionError(f"seeded @revoked entry missing: {json.dumps(entries)[:300]}")
            removed = req("ssh/knownHosts/remove",
                          {"host": "seeded.test", "port": 22}, timeout=30).get("removed")
            if removed != 2:
                raise AssertionError(f"remove should drop marker+plain lines, got removed={removed}")
            listed = req("ssh/knownHosts/list", {}, timeout=30)
            if any(e.get("host") == "seeded.test" for e in listed.get("entries") or []):
                raise AssertionError("seeded.test still listed after removal")
            print(f"    marker roundtrip ok: @cert-authority listed, @revoked listed, "
                  f"remove dropped 2 lines")

        report.run("ssh/sessions/list inventories the current session", "ssh/sessions/list",
                   case_sessions_list)
        report.run("ssh/knownHosts handles marker entries", "ssh/knownHosts/list",
                   case_known_hosts_markers)

        # -- sftp/copy ---------------------------------------------------------

        def case_copy_new_file():
            result = req("sftp/copy", {"sessionId": session_id, "from": [src_a],
                                       "toDir": batch_dir, "overwrite": True})
            results = result.get("results") or []
            if not result.get("success") or len(results) != 1 or not results[0].get("ok"):
                raise AssertionError(f"copy failed: {json.dumps(result)[:160]}")
            stat = req("sftp/stat", {"sessionId": session_id, "path": copied_a})
            if stat.get("size") != 0:
                raise AssertionError(f"copied file size={stat.get('size')!r}, want 0")
            print(f"    copied -> {copied_a}")

        def case_copy_rejects_existing_target():
            result = req("sftp/copy", {"sessionId": session_id, "from": [src_a],
                                       "toDir": batch_dir})
            results = result.get("results") or []
            if result.get("success") or not results or results[0].get("ok"):
                raise AssertionError(f"expected per-item failure: {json.dumps(result)[:160]}")
            if "already exists" not in str(results[0].get("error", "")):
                raise AssertionError(f"unexpected error: {results[0].get('error')!r}")
            print(f"    rejected: {results[0].get('error')}")

        def case_copy_overwrite():
            result = req("sftp/copy", {"sessionId": session_id, "from": [src_a],
                                       "toDir": batch_dir, "overwrite": True})
            if not result.get("success"):
                raise AssertionError(f"overwrite copy failed: {json.dumps(result)[:160]}")
            print("    overwrite copy ok")

        # -- sftp/move ---------------------------------------------------------

        def case_move_file():
            # move batch_dir's copy back home; drop the original first so the
            # target name is free and both existence flips are observable.
            req("sftp/delete", {"sessionId": session_id, "path": src_a})
            result = req("sftp/move", {"sessionId": session_id,
                                       "from": [copied_a], "toDir": home})
            if not result.get("success"):
                raise AssertionError(f"move failed: {json.dumps(result)[:160]}")
            gone = req("sftp/exists", {"sessionId": session_id, "path": copied_a})
            arrived = req("sftp/exists", {"sessionId": session_id, "path": src_a})
            if gone.get("exists") is not False or arrived.get("exists") is not True:
                raise AssertionError(f"move semantics wrong: src exists={gone.get('exists')} "
                                     f"dst exists={arrived.get('exists')}")
            print(f"    moved -> {src_a}")

        # -- batch copy into a directory --------------------------------------

        def case_batch_copy_to_dir():
            req("sftp/touch", {"sessionId": session_id, "path": src_b})
            result = req("sftp/copy", {"sessionId": session_id,
                                       "from": [src_a, src_b], "toDir": batch_dir})
            results = result.get("results") or []
            if not result.get("success") or len(results) != 2 or not all(r.get("ok") for r in results):
                raise AssertionError(f"batch copy failed: {json.dumps(result)[:200]}")
            for path in (copied_a, copied_b):
                present = req("sftp/exists", {"sessionId": session_id, "path": path})
                if present.get("exists") is not True:
                    raise AssertionError(f"{path} missing after batch copy")
            print(f"    2 files copied into {batch_dir}")

        report.run("sftp/copy copies a new file", "sftp/copy", case_copy_new_file)
        report.run("sftp/copy rejects an existing target without overwrite", "sftp/copy",
                   case_copy_rejects_existing_target, needs="sftp/copy copies a new file")
        report.run("sftp/copy overwrite replaces the target", "sftp/copy", case_copy_overwrite,
                   needs="sftp/copy copies a new file")
        report.run("sftp/move renames and drops the source", "sftp/move", case_move_file,
                   needs="sftp/copy copies a new file")
        report.run("sftp/copy batch copy into a directory", "sftp/copy", case_batch_copy_to_dir)

        # -- directory-level copy/move (tiny-rdm FsCopyMove semantics) ---------

        dir_src = f"{home}/.dbx-batch3-dsrc"
        dir_src_inner = f"{dir_src}/inner"
        dir_src_deep = f"{dir_src_inner}/deep.txt"
        deep_content = b"deep payload inside a nested directory\n"
        dir_copy = f"{batch_dir}/.dbx-batch3-dsrc"
        dir_single = f"{home}/.dbx-batch3-dsingle"
        dir_single_copy = f"{dir_single}/.dbx-batch3-dsrc"
        dir_moved = f"{home}/.dbx-batch3-dsrc"
        mv_dir_a = f"{home}/.dbx-batch3-mva"
        mv_dir_b = f"{home}/.dbx-batch3-mvb"
        mv_src = f"{mv_dir_a}/moved.txt"
        mv_dst = f"{mv_dir_b}/moved.txt"
        scratch.extend([
            (dir_src, True), (dir_single, True), (dir_moved, True),
            (mv_dir_a, True), (mv_dir_b, True),
        ])

        def seed_directory_tree() -> None:
            # sftp/createDirectory is single-level (create_dir, not _all), so
            # seed the tree one level at a time.
            ensure_dir(dir_src)
            ensure_dir(dir_src_inner)
            req("sftp/write", {"sessionId": session_id, "remotePath": dir_src_deep,
                               "dataBase64": base64.b64encode(deep_content).decode()})

        def read_size(path: str) -> int:
            stat = req("sftp/stat", {"sessionId": session_id, "path": path})
            return stat.get("size", -1)

        def case_copy_directory_recursively():
            seed_directory_tree()
            ensure_gone(dir_copy)
            result = req("sftp/copy", {"sessionId": session_id, "from": [dir_src],
                                       "toDir": batch_dir})
            if not result.get("success") or not result.get("results", [{}])[0].get("ok"):
                raise AssertionError(f"directory copy failed: {json.dumps(result)[:200]}")
            if read_size(f"{dir_copy}/inner/deep.txt") != len(deep_content):
                raise AssertionError(f"nested file not copied recursively: {dir_copy}/inner/deep.txt")
            listed = req("sftp/list", {"sessionId": session_id, "path": dir_copy})
            inner = next((e for e in listed.get("entries", []) if e.get("name") == "inner"), None)
            if inner is None or inner.get("kind") != "directory":
                raise AssertionError(f"copied tree missing inner directory: {json.dumps(listed)[:200]}")
            print(f"    recursive copy ok: {dir_copy}/inner/deep.txt ({len(deep_content)} B)")

        def case_copy_single_string_from():
            ensure_dir(dir_single)
            ensure_gone(dir_single_copy)
            result = req("sftp/copy", {"sessionId": session_id, "from": dir_src,
                                       "toDir": dir_single})
            if not result.get("success") or not result.get("results", [{}])[0].get("ok"):
                raise AssertionError(f"single-string copy failed: {json.dumps(result)[:200]}")
            if read_size(f"{dir_single_copy}/inner/deep.txt") != len(deep_content):
                raise AssertionError(f"single-string copy lost content: {dir_single_copy}")
            print(f"    single-string from ok: -> {dir_single_copy}")

        def case_copy_move_block_on_existing_targets():
            # dir_copy (case 1) and dir_single_copy (case 2) still exist, so a
            # copy/move without overwrite must fail per item and change nothing.
            result = req("sftp/copy", {"sessionId": session_id, "from": [dir_src],
                                       "toDir": batch_dir})
            results = result.get("results") or []
            if result.get("success") or not results or results[0].get("ok"):
                raise AssertionError(f"expected blocked directory copy: {json.dumps(result)[:200]}")
            if "already exists" not in str(results[0].get("error", "")):
                raise AssertionError(f"unexpected copy error: {results[0].get('error')!r}")
            result = req("sftp/move", {"sessionId": session_id, "from": [dir_copy],
                                       "toDir": dir_single})
            results = result.get("results") or []
            if result.get("success") or not results or results[0].get("ok"):
                raise AssertionError(f"expected blocked directory move: {json.dumps(result)[:200]}")
            if "already exists" not in str(results[0].get("error", "")):
                raise AssertionError(f"unexpected move error: {results[0].get('error')!r}")
            still_there = req("sftp/exists", {"sessionId": session_id, "path": dir_copy})
            if still_there.get("exists") is not True:
                raise AssertionError("blocked move must leave the source in place")
            print(f"    blocked: {results[0].get('error')}")

        def case_move_directory():
            # Relocate the batch_dir copy back home; verifies recursion travels
            # with the move and the source directory disappears.
            ensure_gone(dir_moved)
            result = req("sftp/move", {"sessionId": session_id, "from": [dir_copy],
                                       "toDir": home})
            if not result.get("success") or not result.get("results", [{}])[0].get("ok"):
                raise AssertionError(f"directory move failed: {json.dumps(result)[:200]}")
            gone = req("sftp/exists", {"sessionId": session_id, "path": dir_copy})
            arrived = req("sftp/exists", {"sessionId": session_id, "path": dir_moved})
            if gone.get("exists") is not False or arrived.get("exists") is not True:
                raise AssertionError(f"move semantics wrong: src={gone.get('exists')} dst={arrived.get('exists')}")
            if read_size(f"{dir_moved}/inner/deep.txt") != len(deep_content):
                raise AssertionError("nested file lost during directory move")
            print(f"    directory moved -> {dir_moved}")

        def case_move_overwrite_file_target():
            ensure_dir(mv_dir_a)
            ensure_dir(mv_dir_b)
            req("sftp/write", {"sessionId": session_id, "remotePath": mv_src,
                               "dataBase64": base64.b64encode(b"replacement\n").decode()})
            req("sftp/write", {"sessionId": session_id, "remotePath": mv_dst,
                               "dataBase64": base64.b64encode(b"original\n").decode()})
            result = req("sftp/move", {"sessionId": session_id, "from": [mv_src],
                                       "toDir": mv_dir_b, "overwrite": True})
            if not result.get("success") or not result.get("results", [{}])[0].get("ok"):
                raise AssertionError(f"overwrite move failed: {json.dumps(result)[:200]}")
            read_back = base64.b64decode(req("sftp/read", {"sessionId": session_id,
                                                           "path": mv_dst}).get("dataBase64", ""))
            if read_back != b"replacement\n":
                raise AssertionError(f"overwrite move kept the old content: {read_back!r}")
            gone = req("sftp/exists", {"sessionId": session_id, "path": mv_src})
            if gone.get("exists") is not False:
                raise AssertionError("overwrite move left the source behind")
            print("    overwrite move replaced the file target and dropped the source")

        report.run("sftp/copy copies a directory recursively", "sftp/copy",
                   case_copy_directory_recursively)
        report.run("sftp/copy accepts a single-string from", "sftp/copy",
                   case_copy_single_string_from, needs="sftp/copy copies a directory recursively")
        report.run("sftp/copy and sftp/move block on existing directory targets", "sftp/copy",
                   case_copy_move_block_on_existing_targets,
                   needs="sftp/copy accepts a single-string from")
        report.run("sftp/move relocates a directory", "sftp/move", case_move_directory,
                   needs="sftp/copy copies a directory recursively")
        report.run("sftp/move overwrite replaces an existing file target", "sftp/move",
                   case_move_overwrite_file_target)

    finally:
        # -- cleanup (best effort) --------------------------------------------
        for path, recursive in scratch:
            try:
                client.request("sftp/delete",
                               {"sessionId": session_id, "path": path, "recursive": recursive},
                               timeout=30, on_event=auto_accept_challenge)
            except Exception:
                pass
        try:
            client.request("connection/disconnect", {"connection": {"id": connection_id}}, timeout=30)
        except Exception:
            pass
        client.close()
        shutil.rmtree(data_dir, ignore_errors=True)

    elapsed = time.monotonic() - started
    print(f"\n==== batch3 smoke summary: {len(report.passed)} passed, "
          f"{len(report.skipped)} skipped, {len(report.failed)} failed ({elapsed:.1f}s) ====")
    for title, reason in report.skipped:
        print(f"  SKIP: {title} — {reason}")
    for title, reason in report.failed:
        print(f"  FAIL: {title} — {reason}")
    if report.failed:
        sys.exit(1)
    print("batch3 smoke: all green")


if __name__ == "__main__":
    main()
