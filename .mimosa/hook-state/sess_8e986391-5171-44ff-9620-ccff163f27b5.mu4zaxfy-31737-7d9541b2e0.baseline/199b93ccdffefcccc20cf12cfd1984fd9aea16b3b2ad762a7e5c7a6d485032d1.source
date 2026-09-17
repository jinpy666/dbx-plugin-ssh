#!/usr/bin/env python3
"""Performance baseline smoke: terminal ring-buffer stress + SFTP throughput
against the real SSH test container.

Cases (all against the live PTY/SFTP session, 256 KiB negotiated chunk size):
  1. Terminal 2 MiB ring buffer stress: pipe 5 MiB of output through the
     interactive PTY, drain the binary stream, then call ssh/terminal/replay
     and verify the replayed payload stays within the 2 MiB cap with
     `complete == false` (older frames were evicted) and a contiguous tail.
  2. SFTP upload throughput: stream a 50 MiB file as 256 KiB chunks with
     per-chunk ack backpressure, verify the remote SHA-256, report MB/s.
  3. SFTP download throughput: read the same file back via
     sftp/download/start + sftp/download/next, verify every byte's SHA-256,
     report MB/s.

All numbers print as a table for docs/PROGRESS records. Cases SKIP on
"Method not found" like the other smokes. Scratch files are cleaned up.

Usage:
    DBX_PLUGIN_SIDECAR=backend/target/release/dbx-plugin-ssh-sftp \
        python3 scripts/perf_baseline_test.py            # 50 MiB transfers
    python3 scripts/perf_baseline_test.py --mb 10        # quicker pass
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import secrets
import shutil
import struct
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError, lifecycle_params

CHUNK = 256 * 1024
REPLAY_LIMIT = 2 * 1024 * 1024


def step(name: str) -> None:
    print(f"\n==> {name}")


def missing_method(error: Exception) -> str | None:
    text = str(error)
    if "Method not found" not in text and "-32601" not in text:
        return None
    match = re.search(r"Method not found:\s*([\w./-]+)", text)
    return match.group(1) if match else ""


def auto_accept_challenge(event: dict) -> dict | None:
    if event.get("method") != "connection/challenge":
        return None
    params = event.get("params", {}).get("params") or event.get("params", {})
    if "challengeId" not in params:
        return None
    return {
        "method": "ssh/host-key/resolve",
        "params": {
            "challengeId": params["challengeId"],
            "operationId": params.get("operationId"),
            "accept": True,
            "remember": True,
        },
    }


def mb_s(bytes_count: int, seconds: float) -> float:
    return (bytes_count / (1024 * 1024)) / seconds if seconds > 0 else 0.0


def pop_binary(client: SidecarClient, prefix: str) -> list[tuple[str, bytes]]:
    matched = [(channel, data) for channel, data in client.binary_frames if channel.startswith(prefix)]
    client.binary_frames = [(c, d) for c, d in client.binary_frames if not c.startswith(prefix)]
    return matched


def case_terminal_buffer(client: SidecarClient, session_id: str, mb: int) -> dict:
    """Pipe `mb` MiB through the PTY, then verify the 2 MiB replay cap."""
    step(f"terminal ring buffer stress: {mb} MiB of continuous PTY output")
    client.binary_frames.clear()
    payload = struct.pack(">Q", 1) + f"dd if=/dev/zero bs=1M count={mb} 2>/dev/null | tr '\\0' 'x'\r".encode()
    started = time.monotonic()
    client.send_binary(f"ssh/terminal/in/{session_id}", payload)

    total_bytes = 0
    last_data = time.monotonic()
    reached_at = None
    target = mb * 1024 * 1024
    while time.monotonic() - last_data < 2.0:
        try:
            client.timeout = 1.0
            client._pump(None)
        except SidecarError:
            pass
        finally:
            client.timeout = 30.0
        frames = pop_binary(client, f"ssh/terminal/out/{session_id}")
        if frames:
            total_bytes += sum(len(data) for _, data in frames)
            last_data = time.monotonic()
            if total_bytes >= target and reached_at is None:
                # Timestamp the moment the full payload crossed the wire; the
                # trailing 2s idle window below must not count as ingest time.
                reached_at = last_data
    ingest = (reached_at or last_data) - started
    print(f"    streamed {total_bytes / (1024 * 1024):.2f} MiB through the PTY in {ingest:.2f}s "
          f"({mb_s(total_bytes, ingest):.1f} MiB/s)")

    step("terminal replay after the stress")
    client.binary_frames.clear()
    replay = client.request("ssh/terminal/replay", {"sessionId": session_id, "afterSequence": 0}, timeout=60)
    frames = pop_binary(client, f"ssh/terminal/out/{session_id}")
    replayed_bytes = sum(len(data) for _, data in frames)
    print(f"    replay frameCount={replay.get('frameCount')} firstAvailableSequence={replay.get('firstAvailableSequence')} "
          f"tailSequence={replay.get('tailSequence')} complete={replay.get('complete')}")
    print(f"    replayed payload: {replayed_bytes} bytes ({replayed_bytes / 1024:.0f} KiB) vs "
          f"{REPLAY_LIMIT} byte cap")
    if replayed_bytes > REPLAY_LIMIT + 8 * len(frames) + 1024:
        # The wire payload carries a small per-frame encode header (sequence +
        # stream byte); the buffer cap applies to the data bytes only, so
        # allow that overhead instead of demanding an exact 2 MiB match.
        raise AssertionError(f"replay payload {replayed_bytes} exceeds the {REPLAY_LIMIT} byte cap "
                             f"+ frame overhead ({len(frames)} frames)")
    if replayed_bytes <= REPLAY_LIMIT - 2 * CHUNK:
        raise AssertionError(f"replay payload {replayed_bytes} unexpectedly far below the cap")
    if replay.get("complete") is not False:
        raise AssertionError("replay reports complete=true although 5 MiB were evicted")
    if replay.get("firstAvailableSequence", 0) <= 1:
        raise AssertionError("firstAvailableSequence did not advance past the evicted prefix")
    if replay.get("tailSequence") != replay.get("firstAvailableSequence") + len(frames) - 1:
        raise AssertionError("replay tail/first sequences are not contiguous with the returned frames")
    return {"streamed_mib": round(total_bytes / (1024 * 1024), 2), "ingest_s": round(ingest, 2),
            "ingest_mib_s": round(mb_s(total_bytes, ingest), 1),
            "replayed_bytes": replayed_bytes, "frames": len(frames)}


def case_upload(client: SidecarClient, session_id: str, path: str, data: bytes, digest: str) -> tuple[float, float]:
    """Returns (spool_seconds, network_seconds). Chunks spool to a local
    temp file; the actual SFTP network transfer happens in upload/finish."""
    step(f"sftp upload throughput: {len(data) / (1024 * 1024):.0f} MiB in {CHUNK // 1024} KiB chunks")
    upload = client.request("sftp/upload/start",
                            {"sessionId": session_id, "remotePath": path, "size": len(data)})
    task_id = upload["taskId"]
    if upload.get("chunkSize") and upload["chunkSize"] != CHUNK:
        raise AssertionError(f"negotiated chunk size {upload.get('chunkSize')} != {CHUNK}")
    started = time.monotonic()
    for offset in range(0, len(data), CHUNK):
        chunk = data[offset:offset + CHUNK]
        client.binary_frames.clear()
        client.send_binary(f"sftp/upload/{task_id}", struct.pack(">Q", offset) + chunk)
        while True:
            try:
                client.timeout = 120.0
                client._pump(None)
            except SidecarError:
                raise SidecarError("timeout waiting for sftp/upload/ack")
            finally:
                client.timeout = 30.0
            ack = next((event for event in reversed(client.events)
                        if event.get("method") == "sftp/upload/ack"
                        and event.get("params", {}).get("taskId") == task_id
                        and event.get("params", {}).get("offset") == offset), None)
            if ack is not None:
                break
        client.events = [event for event in client.events
                         if not (event.get("method") == "sftp/upload/ack")]
    spool = time.monotonic() - started
    print(f"    spool: {len(data)} bytes in {spool:.2f}s -> {mb_s(len(data), spool):.1f} MB/s (local temp file)")
    network_started = time.monotonic()
    client.request("sftp/upload/finish", {"taskId": task_id}, timeout=600)
    network = time.monotonic() - network_started
    print(f"    network transfer (upload/finish): {len(data)} bytes in {network:.2f}s -> "
          f"{mb_s(len(data), network):.1f} MB/s over SFTP")
    verify = client.request("ssh/exec", {"sessionId": session_id, "command": f"sha256sum '{path}'"}, timeout=60)
    remote_digest = (verify.get("output") or "").split()[0] if verify.get("output") else ""
    if remote_digest != digest:
        raise AssertionError(f"upload digest mismatch: remote {remote_digest[:16]}... local {digest[:16]}...")
    print(f"    sha256 verified: {digest[:16]}...")
    return spool, network


def case_download(client: SidecarClient, session_id: str, path: str, size: int, digest: str) -> float:
    step(f"sftp download throughput: {size / (1024 * 1024):.0f} MiB in {CHUNK // 1024} KiB chunks")
    download = client.request("sftp/download/start", {"sessionId": session_id, "remotePath": path}, timeout=60)
    task_id = download["taskId"]
    if download.get("size") != size:
        raise AssertionError(f"download size {download.get('size')} != {size}")
    hasher = hashlib.sha256()
    started = time.monotonic()
    offset = 0
    transferred = 0
    while True:
        result = client.request("sftp/download/next", {"taskId": task_id, "offset": offset}, timeout=120)
        frames = pop_binary(client, f"sftp/download/{task_id}")
        if not frames:
            raise AssertionError(f"no binary payload for download chunk at offset {offset}")
        chunk = frames[-1][1][8:]
        hasher.update(chunk)
        transferred += len(chunk)
        if result.get("eof"):
            break
        offset = result.get("nextOffset", offset + len(chunk))
    elapsed = time.monotonic() - started
    client.request("sftp/download/finish", {"taskId": task_id}, timeout=60)
    if transferred != size:
        raise AssertionError(f"downloaded {transferred} bytes, expected {size}")
    if hasher.hexdigest() != digest:
        raise AssertionError("download digest mismatch")
    print(f"    {transferred} bytes in {elapsed:.2f}s -> {mb_s(transferred, elapsed):.1f} MB/s")
    print(f"    sha256 verified: {digest[:16]}...")
    return elapsed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default=None)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2222)
    parser.add_argument("--user", default="sshuser")
    parser.add_argument("--password", default="DbxTest2026")
    parser.add_argument("--mb", type=int, default=50, help="transfer size in MiB")
    args = parser.parse_args()

    started = time.monotonic()
    results: dict[str, dict] = {}
    skips: list[str] = []
    data_dir = tempfile.mkdtemp(prefix="dbx-perf-data-")
    client = None
    connection_id = "smoke-perf-connection"
    session_id = ""
    remote_path = ""
    try:
        step("plugin/initialize + session open")
        client = SidecarClient.start(binary=args.binary, timeout=30, data_dir=data_dir)
        client.initialize()
        connection = {
            "id": connection_id, "name": "smoke-perf", "db_type": "ssh",
            "host": args.host, "port": args.port, "username": args.user,
            "password": args.password, "external_config": {"authentication": "password"},
        }
        client.request("connection/connect", lifecycle_params(connection))
        session = client.request("ssh/session/open",
                                 {"connectionId": connection_id, "workbenchId": "smoke-perf",
                                  "cols": 120, "rows": 30}, timeout=60,
                                 on_event=auto_accept_challenge)
        session_id = session.get("sessionId", "")
        print(f"    session {session_id} opened")

        # -- case 1: terminal ring buffer stress --------------------------------
        try:
            results["terminalBuffer"] = case_terminal_buffer(client, session_id, 5)
        except SidecarError as error:
            missing = missing_method(error)
            if missing is None:
                raise
            skips.append(f"terminal buffer stress ({missing} not registered)")

        # -- cases 2+3: SFTP throughput -----------------------------------------
        remote_path = f"$HOME/.dbx-perf-{secrets.token_hex(4)}.bin"
        actual_home = client.request("ssh/exec", {"sessionId": session_id, "command": "echo $HOME"}, timeout=30)
        home = (actual_home.get("output") or "").strip().splitlines()[-1] if actual_home.get("output") else "/config"
        remote_path = f"{home}/.dbx-perf-{secrets.token_hex(4)}.bin"
        step(f"preparing {args.mb} MiB of random payload")
        data = secrets.token_bytes(args.mb * 1024 * 1024)
        digest = hashlib.sha256(data).hexdigest()
        try:
            spool_s, network_s = case_upload(client, session_id, remote_path, data, digest)
            results["upload"] = {"bytes": len(data), "spool_seconds": round(spool_s, 2),
                                 "spool_mb_s": round(mb_s(len(data), spool_s), 1),
                                 "network_seconds": round(network_s, 2),
                                 "mb_s": round(mb_s(len(data), network_s), 1), "chunk_kib": CHUNK // 1024}
            download_s = case_download(client, session_id, remote_path, len(data), digest)
            results["download"] = {"bytes": len(data), "seconds": round(download_s, 2),
                                   "mb_s": round(mb_s(len(data), download_s), 1), "chunk_kib": CHUNK // 1024}
        except SidecarError as error:
            missing = missing_method(error)
            if missing is None:
                raise
            skips.append(f"sftp throughput ({missing} not registered)")

    except SidecarError as error:
        print(f"FAIL: {error}")
        sys.exit(1)
    finally:
        step("cleanup")
        if client is not None and session_id:
            if remote_path:
                try:
                    client.request("sftp/delete", {"sessionId": session_id, "path": remote_path}, timeout=30)
                except Exception:
                    pass
            try:
                client.request("ssh/session/close", {"sessionId": session_id}, timeout=30)
            except Exception:
                pass
            try:
                client.request("connection/disconnect", {"connection": {"id": connection_id}}, timeout=30)
            except Exception:
                pass
            client.close()
        shutil.rmtree(data_dir, ignore_errors=True)

    print("\n==== performance baseline ====")
    print(f"{'case':<28}{'size':>10}{'time':>10}{'throughput':>14}")
    if "terminalBuffer" in results:
        row = results["terminalBuffer"]
        print(f"{'terminal PTY stream':<28}{row['streamed_mib']:>8} MiB{row['ingest_s']:>8}s{row['ingest_mib_s']:>12} MiB/s")
        print(f"{'terminal replay payload':<28}{row['replayed_bytes'] / (1024 * 1024):>8.2f} MiB"
              f"{'':>10}{row['frames']:>10} frames (cap {REPLAY_LIMIT // (1024 * 1024)} MiB)")
    if "upload" in results:
        row = results["upload"]
        print(f"{'sftp upload (spool)':<28}{row['bytes'] / (1024 * 1024):>8.0f} MiB{row['spool_seconds']:>8}s{row['spool_mb_s']:>12} MB/s")
        print(f"{'sftp upload (network)':<28}{row['bytes'] / (1024 * 1024):>8.0f} MiB{row['network_seconds']:>8}s{row['mb_s']:>12} MB/s")
    if "download" in results:
        row = results["download"]
        print(f"{'sftp download':<28}{row['bytes'] / (1024 * 1024):>8.0f} MiB{row['seconds']:>8}s{row['mb_s']:>12} MB/s")
    for skip in skips:
        print(f"  SKIP: {skip}")
    if not results:
        print("FAIL: no performance case ran")
        sys.exit(1)
    print(f"perf baseline: done in {time.monotonic() - started:.1f}s")


if __name__ == "__main__":
    main()
