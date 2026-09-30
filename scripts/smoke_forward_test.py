#!/usr/bin/env python3
"""End-to-end smoke test for the port mapping capability (ssh/forward/*).

Reuses the smoke flow (initialize -> connection/connect -> ssh/session/open),
then exercises user-facing port forwards against the test container:

  local  (-L): bind 127.0.0.1:0 client-side, dial the container's own SSH port
               through the tunnel and expect an SSH banner;
  remote (-R): ask the server to listen on a server-picked port and relay a
               busybox-nc payload into a local echo server;
  dynamic (-D): negotiate SOCKS5 CONNECT using a domain resolved by the SSH
                server, including concurrent clients and independent lifetime;
  lifecycle:  list rows, stop semantics, unknown-id error, session-close
               cleanup.

Requires the test container to allow TCP forwarding (see the dev skill: run
the linuxserver/openssh-server container with AllowTcpForwarding yes).
Unregistered methods report SKIP (same contract as smoke_fs_test.py); a
server that refuses forwarding (AllowTcpForwarding no) skips the affected
case instead of failing the run.

Usage:
    python3 scripts/smoke_forward_test.py                # default container
    python3 scripts/smoke_forward_test.py --host H --port P --user U --password W
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, lifecycle_params


def step(name: str):
    print(f"\n==> {name}")


def fail(message: str, client: SidecarClient | None = None):
    if client:
        client.close()
    print(f"\nFAIL: {message}", file=sys.stderr)
    sys.exit(1)


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


class SkipSignal(Exception):
    """Environmental skip (forwarding refused, nc missing, ...)."""


def start_forward(client: SidecarClient, session_id: str, kind: str, listen_port: int,
                  target_host: str, target_port: int, listen_host: str = "127.0.0.1") -> dict:
    try:
        result = client.request("ssh/forward/start", {
            "sessionId": session_id,
            "kind": kind,
            "listenHost": listen_host,
            "listenPort": listen_port,
            "targetHost": target_host,
            "targetPort": target_port,
        }, timeout=30)
    except Exception as error:  # noqa: BLE001 - classify then re-raise
        text = str(error)
        # The conflict pre-check is a real contract, never an environmental skip.
        if "already forwarded" in text:
            raise
        if "forwarding" in text.lower() or "administratively" in text.lower() or "listen" in text.lower():
            raise SkipSignal(f"server refused {kind} forward: {text}") from error
        raise
    forward = (result or {}).get("forward") or {}
    if not forward.get("id"):
        raise AssertionError(f"ssh/forward/start returned no forward row: {result!r}")
    if forward.get("state") != "active":
        raise AssertionError(f"forward not active after start: {forward!r}")
    return forward


class EchoServer(threading.Thread):
    """One-shot accept loop echoing everything back; records received bytes."""

    def __init__(self):
        super().__init__(daemon=True)
        self.received = b""
        self.event = threading.Event()
        self._server = socket.socket()
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(("127.0.0.1", 0))
        self._server.listen(1)
        self.port = self._server.getsockname()[1]

    def run(self):
        try:
            conn, _ = self._server.accept()
            with conn:
                conn.settimeout(15)
                while True:
                    try:
                        chunk = conn.recv(4096)
                    except TimeoutError:
                        # busybox nc can hold the socket after EOF; the echo
                        # already happened, so just end the accept cycle.
                        break
                    if not chunk:
                        break
                    self.received += chunk
                    conn.sendall(chunk)
        finally:
            self._server.close()
            self.event.set()


def read_ssh_banner(port: int, timeout: float = 10.0) -> str:
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        return sock.recv(64).decode("utf-8", "replace")


def read_socks5_banner(proxy_port: int, target_port: int) -> str:
    """Use a domain-form CONNECT so localhost is resolved by the SSH server."""
    with socket.create_connection(("127.0.0.1", proxy_port), timeout=10) as sock:
        sock.settimeout(10)
        sock.sendall(b"\x05\x01\x00")
        if sock.recv(2) != b"\x05\x00":
            raise AssertionError("SOCKS5 no-auth negotiation failed")
        host = b"localhost"
        sock.sendall(b"\x05\x01\x00\x03" + bytes([len(host)]) + host + target_port.to_bytes(2, "big"))
        reply = sock.recv(10)
        if len(reply) != 10 or reply[:2] != b"\x05\x00":
            raise AssertionError(f"SOCKS5 CONNECT failed: {reply!r}")
        return sock.recv(64).decode("utf-8", "replace")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2222)
    parser.add_argument("--user", default="sshuser")
    parser.add_argument("--password", default="DbxTest2026")
    args = parser.parse_args()

    started = time.monotonic()
    data_dir = tempfile.mkdtemp(prefix="dbx-forward-smoke-")
    client = SidecarClient.start(timeout=30, data_dir=data_dir)
    try:
        step("plugin/initialize")
        client.initialize()

        connection_id = "smoke-forward-connection"
        connection = {
            "id": connection_id,
            "name": "smoke-forward",
            "db_type": "ssh",
            "host": args.host,
            "port": args.port,
            "username": args.user,
            "password": args.password,
            "external_config": {"authentication": "password"},
        }
        step("connection/connect + ssh/session/open")
        client.request("connection/connect", lifecycle_params(connection))
        session = client.request("ssh/session/open", {
            "connectionId": connection_id,
            "workbenchId": "smoke-forward",
            "cols": 120,
            "rows": 30,
        }, timeout=60, on_event=auto_accept_challenge)
        session_id = session["sessionId"]
        print(f"    session {session_id} opened")

        def req(method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
            return client.request(method, params or {}, timeout=timeout)

        stopped_ids: list[str] = []

        def case_local_forward_roundtrip():
            """-L: local listener dials the SSH server through the tunnel."""
            forward = start_forward(client, session_id, "local", 0, "127.0.0.1", args.port)
            bound = int(forward.get("boundPort") or 0)
            if bound <= 0:
                raise AssertionError(f"local forward has no bound port: {forward!r}")
            banner = read_ssh_banner(bound)
            if not banner.startswith("SSH-"):
                raise AssertionError(f"tunnel banner unexpected: {banner!r}")
            print(f"    local -L 127.0.0.1:{bound} -> 127.0.0.1:{args.port} banner {banner.strip()!r}")
            rows = req("ssh/forward/list", {"connectionId": connection_id}).get("forwards") or []
            if not any(row.get("id") == forward["id"] for row in rows):
                raise AssertionError(f"list missing local forward: {rows!r}")
            if not any(int(row.get("connectionsTotal") or 0) >= 1 and row.get("id") == forward["id"] for row in rows):
                raise AssertionError(f"local forward counted no connections: {rows!r}")
            stopped_ids.append(forward["id"])
            return forward

        def case_remote_forward_roundtrip():
            """-R: server-side port relays busybox-nc traffic to a local echo."""
            echo = EchoServer()
            echo.start()
            try:
                forward = start_forward(client, session_id, "remote", 0, "127.0.0.1", echo.port)
                remote_port = int(forward.get("boundPort") or 0)
                if remote_port <= 0:
                    raise AssertionError(f"remote forward has no bound port: {forward!r}")
                exec_result = req("ssh/exec", {
                    "sessionId": session_id,
                    "command": f"printf hello-forward | nc 127.0.0.1 {remote_port}",
                    "timeoutSecs": 20,
                }, timeout=30)
                output = str(exec_result.get("output") or "")
                if not echo.event.wait(20):
                    raise AssertionError("echo server never saw a connection")
                if b"hello-forward" not in echo.received:
                    raise AssertionError(f"echo server received {echo.received!r}")
                if "hello-forward" not in output:
                    raise AssertionError(f"nc echo-back missing in exec output: {output!r}")
                print(f"    remote -R 127.0.0.1:{remote_port} -> 127.0.0.1:{echo.port} payload ok")
                stopped_ids.append(forward["id"])
                return forward
            except SkipSignal:
                raise
            except Exception as error:  # noqa: BLE001 - nc missing on the image
                if "not found" in str(error).lower():
                    raise SkipSignal(f"busybox nc unavailable: {error}") from error
                raise

        def case_stop_and_unknown_id():
            """Stop removes the row; stopping an unknown id is an error."""
            if not stopped_ids:
                raise SkipSignal("no forwards to stop")
            first = stopped_ids[0]
            req("ssh/forward/stop", {"id": first})
            rows = req("ssh/forward/list", {"connectionId": connection_id}).get("forwards") or []
            if any(row.get("id") == first for row in rows):
                raise AssertionError(f"stopped forward still listed: {rows!r}")
            try:
                req("ssh/forward/stop", {"id": first})
            except AssertionError:
                raise
            except Exception as error:  # noqa: BLE001 - expected not-found
                if "not found" not in str(error).lower():
                    raise AssertionError(f"stop(unknown) unexpected error: {error}") from error
            else:
                raise AssertionError("stop(unknown id) must fail")
            print(f"    stop {first} ok, unknown-id rejected")
            # Remaining forward (if the remote case ran) is torn down below.

        def case_session_close_cleans_up():
            """Closing the session must clear its forwards from the registry."""
            second = req("ssh/session/open", {
                "connectionId": connection_id,
                "workbenchId": "smoke-forward-close",
                "cols": 80,
                "rows": 24,
            })
            closeable = second["sessionId"]
            forward = start_forward(client, closeable, "local", 0, "127.0.0.1", args.port)
            req("ssh/session/close", {"sessionId": closeable})
            rows = req("ssh/forward/list", {"connectionId": connection_id}).get("forwards") or []
            if any(row.get("id") == forward["id"] for row in rows):
                raise AssertionError(f"session close left a forward behind: {rows!r}")
            print(f"    session close cleaned forward {forward['id']}")

        def case_conflict_detection():
            """A duplicate listen endpoint fails with the naming pre-check."""
            probe = socket.socket()
            probe.bind(("127.0.0.1", 0))
            free_port = probe.getsockname()[1]
            probe.close()
            first = start_forward(client, session_id, "local", free_port, "127.0.0.1", args.port)
            stopped_ids.append(first["id"])
            try:
                start_forward(client, session_id, "local", free_port, "127.0.0.1", 22)
            except SkipSignal:
                raise
            except Exception as error:  # noqa: BLE001 - the expected conflict
                if "already forwarded" not in str(error):
                    raise AssertionError(f"duplicate rejected with unexpected error: {error}") from error
            else:
                raise AssertionError("duplicate listen endpoint must be rejected")
            # Wildcard overlaps the concrete binding too.
            try:
                start_forward(client, session_id, "local", free_port, "0.0.0.0", 22)
            except SkipSignal:
                raise
            except Exception as error:  # noqa: BLE001 - the expected conflict
                if "already forwarded" not in str(error):
                    raise AssertionError(f"wildcard duplicate error unexpected: {error}") from error
            else:
                raise AssertionError("wildcard overlap must be rejected")
            print(f"    duplicate + wildcard overlap on 127.0.0.1:{free_port} rejected")

        def case_interface_probe():
            """ssh/forward/interfaces reports loopback addresses of this host."""
            result = req("ssh/forward/interfaces")
            rows = result.get("interfaces") or []
            addrs = {str(row.get("addr")) for row in rows}
            if not rows:
                print("    no interfaces reported (degraded picker) — accepted")
                return
            if "127.0.0.1" not in addrs and "::1" not in addrs:
                raise AssertionError(f"probe missing loopback address: {sorted(addrs)}")
            print(f"    probe returned {len(rows)} addresses (loopback present)")

        def case_independent_dynamic():
            """A PTY-free -D stays live across terminal close, then frees its port."""
            result = req("ssh/forward/start", {
                "connectionId": connection_id,
                "kind": "dynamic",
                "listenPort": 0,
            }, timeout=60)
            forward = result["forward"]
            bound = int(forward["boundPort"])
            if forward["sessionId"] or forward["listenHost"] != "127.0.0.1" or bound <= 0:
                raise AssertionError(f"independent dynamic row invalid: {forward!r}")
            try:
                req("ssh/session/close", {"sessionId": session_id})
                results: list[str] = []
                errors: list[Exception] = []

                def worker():
                    try:
                        results.append(read_socks5_banner(bound, args.port))
                    except Exception as error:  # noqa: BLE001 - report from worker
                        errors.append(error)

                workers = [threading.Thread(target=worker) for _ in range(2)]
                for worker_thread in workers:
                    worker_thread.start()
                for worker_thread in workers:
                    worker_thread.join(15)
                if errors or len(results) != 2 or any(not item.startswith("SSH-") for item in results):
                    raise AssertionError(f"concurrent SOCKS5 roundtrips failed: {results!r}, {errors!r}")
                print(f"    -D 127.0.0.1:{bound} survived terminal close; concurrent domain CONNECT succeeded")
            finally:
                req("ssh/forward/stop", {"id": forward["id"]})
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", bound))
            print(f"    stop released 127.0.0.1:{bound}")

        cases = [
            ("local -L roundtrip through the tunnel", case_local_forward_roundtrip, None),
            ("remote -R roundtrip via busybox nc", case_remote_forward_roundtrip, None),
            ("stop semantics + unknown-id error", case_stop_and_unknown_id, None),
            ("conflict pre-check (duplicate + wildcard)", case_conflict_detection, None),
            ("interface probe exposes loopback", case_interface_probe, None),
            ("session close clears the registry", case_session_close_cleans_up, None),
        ]
        for title, case, needs in cases:
            step(title)
            try:
                case()
            except SkipSignal as skip:
                print(f"SKIP: {title}: {skip}")
            except AssertionError as error:
                fail(f"{title}: {error}", client)
            except Exception as error:  # noqa: BLE001 - unregistered method skip
                method = missing_method(error)
                if method is not None:
                    print(f"SKIP: {method} not registered in this build")
                else:
                    fail(f"{title}: {error}", client)

        # Tear down any forward the earlier cases left (remote case stops only
        # its own row when both ran).
        for row in req("ssh/forward/list", {"connectionId": connection_id}).get("forwards") or []:
            try:
                req("ssh/forward/stop", {"id": row["id"]})
            except Exception:  # noqa: S110 - best-effort teardown
                pass

        step("independent SOCKS5 survives terminal close and frees port")
        try:
            case_independent_dynamic()
        except Exception as error:  # noqa: BLE001 - feature contract must pass
            fail(f"independent SOCKS5: {error}", client)

        step("connection disconnect cleans independent listener")
        try:
            forward = req("ssh/forward/start", {
                "connectionId": connection_id,
                "kind": "dynamic",
                "listenPort": 0,
            }, timeout=60)["forward"]
            bound = int(forward["boundPort"])
            req("connection/disconnect", {"connection": {"id": connection_id}})
            rows = req("ssh/forward/list", {"connectionId": connection_id}).get("forwards") or []
            if any(row["id"] == forward["id"] for row in rows):
                raise AssertionError(f"disconnected forward still listed: {rows!r}")
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", bound))
            print(f"    disconnect removed {forward['id']} and released 127.0.0.1:{bound}")
        except Exception as error:  # noqa: BLE001 - lifecycle contract must pass
            fail(f"independent disconnect cleanup: {error}", client)

        print(f"\nALL FORWARD SMOKE CASES PASSED in {time.monotonic() - started:.1f}s")
    finally:
        client.close()
        shutil.rmtree(data_dir)


if __name__ == "__main__":
    main()
