#!/usr/bin/env python3
"""Drive the dbx-plugin-ssh sidecar over its stdio-framed protocol.

Frame format (dbx-plugin-sdk): 5-byte header [kind:u8][length:u32 BE] + payload.
kind 0 = JSON (jsonrpc 2.0 requests/notifications), kind 1 = binary.

Usage as a library:
    from sidecar_client import SidecarClient
    client = SidecarClient.start_default()
    client.initialize()
    client.request("connection/connect", {...})
"""

from __future__ import annotations

import json
import os
import queue
import select
import struct
import subprocess
import sys
import threading
import time

FRAME_JSON = 0
FRAME_BINARY = 1
PROTOCOL_VERSION = 1

# sentinel returned via on_event handling to signal "handled, keep waiting"
_EVENT_HANDLED = object()


def default_binary() -> str:
    env = os.environ.get("DBX_PLUGIN_SIDECAR")
    if env:
        return env
    home = os.path.expanduser("~")
    return (
        f"{home}/Library/Application Support/com.dbx.app/plugins/io.dbx.ssh-sftp/"
        f"versions/current/bin/darwin-arm64/dbx-plugin-ssh"
    )


class SidecarError(RuntimeError):
    pass


class SidecarClient:
    def __init__(self, process: subprocess.Popen, read_fd: int, timeout: float = 20.0):
        self.process = process
        self.read_fd = read_fd
        self.timeout = timeout
        self.next_id = 1
        self.events: list[dict] = []
        self.binary_frames: list[bytes] = []
        self._pending: dict[int, dict] = {}
        # One dedicated reader thread feeds a byte queue; every read on any
        # platform pulls from it. Rationale: a pipe fd cannot be select()ed
        # on Windows (WinError 10038), and the previous workaround — a probe
        # thread doing a 1-byte os.read per wait — stayed blocked on the pipe
        # after every timeout, and the first byte of the next burst was won
        # by that zombie and lost forever (framing desync → the next blocking
        # read hung the smoke scripts). The queue keeps timeouts loss-free:
        # nothing is consumed off the pipe except by the framing layer.
        self._chunks: "queue.SimpleQueue[bytes | None]" = queue.SimpleQueue()
        self._read_closed = False
        # Whole pipe chunks land here; _read_bytes slices off exactly what the
        # framing layer asks for, so a read never over-consumes past the frame
        # boundary (a 64KiB os.read chunk usually spans several frames).
        self._leftover = bytearray()
        threading.Thread(target=self._reader_loop, daemon=True).start()

    def _reader_loop(self) -> None:
        while True:
            try:
                chunk = os.read(self.read_fd, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                self._chunks.put(None)  # EOF / pipe closed: one sentinel
                return
            self._chunks.put(chunk)

    def _read_chunk(self, timeout: float) -> bytes:
        if self._read_closed:
            raise SidecarError("sidecar closed")
        try:
            chunk = self._chunks.get(timeout=timeout)
        except queue.Empty:
            raise SidecarError("timeout waiting for sidecar frame") from None
        if chunk is None:
            self._read_closed = True
            raise SidecarError("sidecar closed")
        return chunk

    @classmethod
    def start(cls, binary: str | None = None, data_dir: str | None = None, timeout: float = 20.0) -> "SidecarClient":
        binary = binary or default_binary()
        if not os.path.exists(binary):
            raise SidecarError(f"sidecar binary not found: {binary} (set DBX_PLUGIN_SIDECAR)")
        env = dict(os.environ)
        if data_dir:
            env["DBX_PLUGIN_DATA_DIR"] = data_dir
        process = subprocess.Popen(
            [binary],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        client = cls(process, process.stdout.fileno(), timeout)
        # Windows pipe buffers are small; the sidecar's eprintln diagnostics
        # (sidecar-exit markers, job-object banner) block forever once the
        # stderr buffer fills and no one reads it. Drain it in the
        # background; tests that need the text can swap in their own pump.
        def _drain_stderr() -> None:
            try:
                for _ in iter(process.stderr.readline, b""):
                    pass
            except Exception:
                pass
        threading.Thread(target=_drain_stderr, daemon=True).start()
        return client

    # -- low-level framing ---------------------------------------------------

    def _read_bytes(self, count: int, deadline: float | None = None) -> bytes:
        """Read exactly `count` bytes (sliced from whole pipe chunks).

        Honors `deadline` (monotonic clock) when set: a chunk that does not
        arrive in time raises SidecarError("timeout...") without discarding
        whatever already arrived — the rest of a partially read frame stays
        in _leftover, exactly like the pre-timeout state of a blocking read.
        """
        chunks = bytearray()
        while len(chunks) < count:
            if self._leftover:
                need = count - len(chunks)
                chunks.extend(self._leftover[:need])
                del self._leftover[:need]
                continue
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                raise SidecarError("timeout waiting for sidecar frame")
            budget = self.timeout if remaining is None else remaining
            self._leftover.extend(self._read_chunk(budget))
        return bytes(chunks)

    def _send_raw(self, kind: int, payload: bytes) -> None:
        assert self.process.stdin
        self.process.stdin.write(struct.pack(">BI", kind, len(payload)))
        self.process.stdin.write(payload)
        self.process.stdin.flush()

    def _read_frame(self, deadline: float) -> tuple[int, bytes]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise SidecarError("timeout waiting for sidecar frame")
        header = self._read_bytes(5, deadline)
        if len(header) < 5:
            raise SidecarError(f"sidecar closed (header={header!r})")
        kind = header[0]
        (length,) = struct.unpack(">I", header[1:5])
        payload = self._read_bytes(length, deadline)
        return kind, payload

    def _pump(self, want_id: int | None = None, on_event=None) -> object:
        """Read frames until a response for want_id arrives; stash events.

        on_event(message) may return a dict (sent as a follow-up request,
        e.g. resolving a host-key challenge) to keep flows single-threaded.
        A ``{"__host_response__": json_rpc_response}`` return value answers a
        plugin-initiated Host API request such as ``host/requestUserInput``.
        """
        deadline = time.monotonic() + self.timeout
        while True:
            kind, payload = self._read_frame(deadline)
            if kind == FRAME_BINARY:
                # binary payload: [u16 BE channel_len][channel][data]
                (channel_len,) = struct.unpack(">H", payload[:2])
                channel = payload[2:2 + channel_len].decode(errors="replace")
                self.binary_frames.append((channel, payload[2 + channel_len:]))
                if want_id is None:
                    return None
                continue
            message = json.loads(payload)
            if want_id is not None and message.get("id") == want_id:
                if "error" in message and message["error"] is not None:
                    raise SidecarError(f"{message['error'].get('message')}: {message['error'].get('data', '')}")
                return message.get("result")
            # notification / unrelated response
            self.events.append(message)
            if want_id is None:
                return None
            if on_event is not None:
                reply = on_event(message)
                if isinstance(reply, dict):
                    host_response = reply.get("__host_response__")
                    if isinstance(host_response, dict):
                        self._send_raw(FRAME_JSON, json.dumps(host_response).encode())
                        deadline = time.monotonic() + self.timeout
                        continue
                    sub = {"jsonrpc": "2.0", "id": self.next_id, "method": reply["method"],
                           "params": reply.get("params", {})}
                    self.next_id += 1
                    self._send_raw(FRAME_JSON, json.dumps(sub).encode())
            # events arriving while a request is in flight must not consume
            # its timeout budget
            deadline = time.monotonic() + self.timeout

    # -- protocol ------------------------------------------------------------

    def initialize(self, enable_user_input: bool = False) -> dict:
        host = {"protocolVersions": [PROTOCOL_VERSION]}
        if enable_user_input:
            host.update({
                "hostApiVersion": "1.1.0",
                "features": ["host.requestUserInput"],
            })
        return self.request(
            "plugin/initialize",
            {"host": host},
        )

    def request(self, method: str, params: dict | None = None, timeout: float | None = None,
                on_event=None) -> dict:
        """Send a request and wait for its response.

        on_event(message) is invoked synchronously for every notification that
        arrives while waiting; return a dict from it to send it as a request.
        This keeps challenge/response flows single-threaded.
        """
        if timeout:
            previous, self.timeout = self.timeout, timeout
        request_id = self.next_id
        self.next_id += 1
        message = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}
        self._send_raw(FRAME_JSON, json.dumps(message).encode())
        try:
            result = self._pump(request_id, on_event=on_event)
            return result if isinstance(result, dict) else {}
        finally:
            if timeout:
                self.timeout = previous

    def request_batch(self, specs: list[dict], on_event=None) -> list[dict]:
        """Send several requests at once and route one pump loop by id.

        Each spec is {"method": str, "params": dict, "timeout": float}. Ids
        are assigned in order and every frame is written up front so the
        sidecar's worker pool can process them concurrently (cross-connection
        calls genuinely overlap); a single pump loop then collects responses
        keyed by id. Notifications are handled exactly like `request`:
        appended to self.events, and a dict returned from on_event is sent as
        a follow-up request.

        The pump budget is the largest spec timeout; each frame read refreshes
        it so an event burst cannot starve a slow response. Never raises:
        entries that time out or come back as JSON-RPC errors carry
        {"__error": str} so callers (smoke tests) do their own asserting.
        """
        total_timeout = max(
            (float(spec.get("timeout", self.timeout)) for spec in specs),
            default=self.timeout,
        )
        ids = []
        try:
            for spec in specs:
                request_id = self.next_id
                self.next_id += 1
                ids.append(request_id)
                message = {"jsonrpc": "2.0", "id": request_id,
                           "method": spec["method"], "params": spec.get("params") or {}}
                self._send_raw(FRAME_JSON, json.dumps(message).encode())
            results: dict[int, dict] = {}
            pending = set(ids)
            previous, self.timeout = self.timeout, total_timeout
            deadline = time.monotonic() + total_timeout
            while pending:
                kind, payload = self._read_frame(deadline)
                if kind == FRAME_BINARY:
                    # binary payload: [u16 BE channel_len][channel][data]
                    (channel_len,) = struct.unpack(">H", payload[:2])
                    channel = payload[2:2 + channel_len].decode(errors="replace")
                    self.binary_frames.append((channel, payload[2 + channel_len:]))
                    continue
                message = json.loads(payload)
                message_id = message.get("id")
                if message_id in pending:
                    pending.discard(message_id)
                    if "error" in message and message["error"] is not None:
                        results[message_id] = {
                            "__error": (f"{message['error'].get('message')}: "
                                        f"{message['error'].get('data', '')}"),
                        }
                    else:
                        result = message.get("result")
                        results[message_id] = result if isinstance(result, dict) else {}
                    continue
                # notification / unrelated response: same handling as _pump
                self.events.append(message)
                if on_event is not None:
                    reply = on_event(message)
                    if isinstance(reply, dict):
                        host_response = reply.get("__host_response__")
                        if isinstance(host_response, dict):
                            self._send_raw(FRAME_JSON, json.dumps(host_response).encode())
                            deadline = time.monotonic() + total_timeout
                            continue
                        sub = {"jsonrpc": "2.0", "id": self.next_id, "method": reply["method"],
                               "params": reply.get("params", {})}
                        self.next_id += 1
                        self._send_raw(FRAME_JSON, json.dumps(sub).encode())
                # events arriving while requests are in flight must not
                # consume their timeout budget
                deadline = time.monotonic() + total_timeout
            return [results.get(request_id) for request_id in ids]
        except SidecarError as error:
            # Timeout or a closed pipe: hand every missing entry back as an
            # error element instead of raising past the caller.
            return [
                results.get(request_id, {"__error": str(error)}) if "results" in locals()
                else {"__error": str(error)}
                for request_id in ids
            ]
        finally:
            if "previous" in locals():
                self.timeout = previous

    def send_binary(self, channel: str, data: bytes) -> None:
        # payload layout: [u16 BE channel_len][channel bytes][data]
        channel_bytes = channel.encode()
        self._send_raw(FRAME_BINARY, struct.pack(">H", len(channel_bytes)) + channel_bytes + data)

    def wait_event(self, method: str, timeout: float = 10.0) -> dict | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for event in self.events:
                if event.get("method") == method or str(event.get("params", {}).get("method", "")).endswith(method):
                    return event
            self.timeout = max(0.5, deadline - time.monotonic())
            try:
                self._pump(None)
            except SidecarError:
                break
        for event in self.events:
            if event.get("method") == method:
                return event
        return None

    def drain_stderr(self) -> str:
        try:
            return self.process.stderr.read().decode(errors="replace") if self.process.stderr else ""
        except Exception:
            return ""

    def close(self) -> None:
        try:
            if self.process.stdin:
                self.process.stdin.close()
            self.process.wait(timeout=5)
        except Exception:
            self.process.kill()


class McpStdioClient:
    """Line-delimited MCP (2024-11-05) JSON-RPC client for one `--mcp` sidecar
    process. Complements SidecarClient (plugin protocol) for exercising the
    MCP tool surface the way external MCP clients do."""

    def __init__(self, binary: str, env_extra: dict[str, str] | None = None,
                 stderr: int | None = subprocess.DEVNULL):
        env = dict(os.environ)
        if env_extra:
            env.update(env_extra)
        self.binary = binary
        self.proc = subprocess.Popen(
            [binary, "--mcp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            env=env,
        )
        self.next_id = 1

    def call(self, method: str, params: dict | None = None,
             timeout: float = 120.0) -> dict:
        """Sends one request and returns the first response with a matching id.

        The read waits with select() bounded by `timeout` so a silent sidecar
        cannot block readline() forever."""
        request_id = self.next_id
        self.next_id += 1
        frame = {"jsonrpc": "2.0", "id": request_id,
                 "method": method, "params": params or {}}
        self._send(frame)
        deadline = time.monotonic() + timeout
        stdout = self.proc.stdout
        assert stdout is not None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            ready, _, _ = select.select([stdout], [], [], min(remaining, 1.0))
            if not ready:
                continue
            line = stdout.readline()
            if not line:
                break
            message = json.loads(line)
            if message.get("id") == request_id:
                return message
        raise SidecarError(f"no response for id {request_id} ({method}) "
                           f"within {timeout}s")

    def notify(self, method: str) -> None:
        self._send({"jsonrpc": "2.0", "method": method})

    def _send(self, frame: dict) -> None:
        # MCP stdio is newline-delimited JSON-RPC: the trailing newline is
        # what terminates the child's line read.
        data = json.dumps(frame, ensure_ascii=False).encode("utf-8") + b"\n"
        stdin = self.proc.stdin
        assert stdin is not None
        stdin.write(data)
        stdin.flush()

    def initialize(self) -> dict:
        result = self.call("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "sidecar-client"},
        }, timeout=30)
        self.notify("notifications/initialized")
        return result

    def call_tool(self, name: str, arguments: dict, timeout: float = 120.0) -> dict:
        message = self.call("tools/call", {"name": name, "arguments": arguments},
                            timeout=timeout)
        if "error" in message:
            raise SidecarError(str(message["error"].get("message"))[:400])
        return message.get("result") or {}

    def close(self) -> None:
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def lifecycle_params(connection: dict) -> dict:
    """Build connection lifecycle params the way the DBX host does."""
    return {
        "provider": {"id": "io.dbx.ssh-sftp.connection", "databaseType": "ssh"},
        "connection": connection,
        "runtime": {"host": connection.get("host"), "port": connection.get("port", 22)},
    }


if __name__ == "__main__":
    client = SidecarClient.start()
    try:
        info = client.initialize()
        print(json.dumps(info, indent=2, ensure_ascii=False))
    finally:
        client.close()
