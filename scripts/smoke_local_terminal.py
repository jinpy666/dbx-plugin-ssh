#!/usr/bin/env python3
"""Local terminal smoke test: local/terminal/* against a real sidecar (no SSH).

Drives the sidecar's local terminal end to end on the machine running this
script — no SSH server or docker container involved:

  1. local/terminal/start spawns the platform's login shell with shell
     integration injected (integration response carries shellIntegration),
  2. the output channel carries the OSC 133;A prompt mark (injection live),
  3. keyboard input (8-byte BE sequence + bytes) round-trips: an echo probe
     command's output comes back with OSC 133;D;0 (command completed clean),
  4. resize + local/session/list answer,
  5. local/session/close terminates the child and the exit event arrives
     (local/session/state {state: "exited"}).

Skips (exit 0) when the sidecar binary is unavailable — same self-gating
semantics as the live-container smokes. Run directly:

    python3 scripts/smoke_local_terminal.py [--binary backend/target/release/dbx-plugin-ssh]
"""

import argparse
import os
import struct
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
from sidecar_client import SidecarClient  # noqa: E402


def collect_until(client, out_channel, in_channel, ready, done, deadline_s=15.0):
    """Pump frames via harmless list requests; type the probe line once the
    first prompt mark arrives; stop when `done(text)` holds."""
    collected = bytearray()
    sent = False
    end = time.time() + deadline_s
    while time.time() < end:
        client.request("local/session/list", timeout=5)
        for channel, payload in client.binary_frames:
            if channel == out_channel:
                collected.extend(payload)
        client.binary_frames.clear()
        text = bytes(collected)
        if ready(text) and not sent:
            sent = True
            client.send_binary(in_channel, struct.pack(">Q", 1) + b"echo DBX_SMOKE_$((6*7))_OK COLORTERM=$COLORTERM\r")
        if done(text):
            return text
        time.sleep(0.1)
    return bytes(collected)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default="backend/target/release/dbx-plugin-ssh")
    args = parser.parse_args()
    if not os.path.isfile(args.binary):
        print(f"SKIP: sidecar binary not found: {args.binary}")
        return 0

    with tempfile.TemporaryDirectory(prefix="dbx-local-smoke-") as data_dir:
        client = SidecarClient.start(binary=args.binary, data_dir=data_dir)
        try:
            client.initialize()

            # shell 发现：本机至少能列出一个可启动 shell（多平台设置的数据源）。
            inventory = client.request("local/shells/list")
            shells = inventory["shells"]
            assert shells, f"no shells discovered on {inventory.get('platform')}"
            print("shells:", [f"{s['name']}({s['program']})" for s in shells])

            # 偏好往返：shell 选择 + 注入开关（workbench 设置面板的存储层）。
            client.request("local/preferences/set", {"localShell": shells[0]["program"], "localShellIntegration": False})
            prefs = client.request("local/preferences/get")
            assert prefs.get("localShell") == shells[0]["program"], prefs
            assert prefs.get("localShellIntegration") is False, prefs
            client.request("local/preferences/set", {"localShellIntegration": True})
            assert client.request("local/preferences/get").get("localShellIntegration") is True

            # 显式 shell 启动：返回的 shell 必须回显请求值（cwd 非法值回落家目录）。
            started = client.request(
                "local/terminal/start",
                {
                    "workbenchId": "smoke-wb",
                    "cols": 100,
                    "rows": 30,
                    "shell": shells[0]["program"],
                    "cwd": "/nonexistent-dir-should-fall-back",
                },
            )
            assert started["shell"] == shells[0]["program"], started
            session_id = started["sessionId"]
            print("started:", started)
            # 可注入的 shell（zsh/bash/fish/pwsh）才会置 true；cmd/unknown 为
            # false 且没有 OSC 标记，用例按 shellIntegration 分支。
            integrated = started.get("shellIntegration") is True

            out = f"local/terminal/out/{session_id}"
            text = collect_until(
                client,
                out,
                f"local/terminal/in/{session_id}",
                ready=lambda chunk: b"\x1b]133;A" in chunk,
                done=lambda chunk: b"\x1b]133;A" in chunk and b"DBX_SMOKE_42_OK" in chunk and b"COLORTERM=truecolor" in chunk,
            )
            if integrated:
                assert b"\x1b]133;A" in text, f"no OSC 133;A prompt mark; tail={text[-160:]!r}"
                assert b"\x1b]133;D;0" in text, f"no OSC 133;D;0 exit-code mark; tail={text[-160:]!r}"
            assert b"DBX_SMOKE_42_OK" in text, f"echo missing; tail={text[-160:]!r}"
            if integrated:
                assert b"COLORTERM=truecolor" in text, "COLORTERM not injected"
            print(f"echo round-trip OK ({len(text)} bytes, integration={integrated})")

            client.request(
                "local/terminal/resize", {"sessionId": session_id, "cols": 120, "rows": 40}
            )
            listing = client.request("local/session/list")
            assert any(s["sessionId"] == session_id for s in listing["sessions"]), "not listed"
            print("resize + list ok")

            # 输入 burst（对齐 SSH burst 回归思路）：60 帧/15ms 全部 ack，
            # 会话保持存活、无错误事件——SDK lane 有序 + 有界背压在本地通道同样生效。
            acked = set()
            scanned = 0  # client.events 只增不减，用游标避免重复计数
            for i in range(60):
                client.send_binary(
                    f"local/terminal/in/{session_id}", struct.pack(">Q", i + 10) + b"x"
                )
                time.sleep(0.015)
            deadline_burst = time.time() + 10
            while time.time() < deadline_burst and len(acked) < 60:
                client.request("local/session/list", timeout=5)  # 顺带泵帧
                while scanned < len(client.events):
                    event = client.events[scanned]
                    scanned += 1
                    if event.get("method") == "local/terminal/inputAck" and 10 <= event["params"]["sequence"] < 70:
                        acked.add(event["params"]["sequence"])
                if len(acked) >= 60:
                    break
                time.sleep(0.05)
            assert len(acked) == 60, f"ack coverage {len(acked)}/60"
            errors = [e for e in client.events if e.get("method") == "local/terminal/error"]
            assert not errors, f"error events during burst: {errors}"
            print("burst 60 frames all acked, session alive")

            client.request("local/session/close", {"sessionId": session_id})
            event = client.wait_event("local/session/state", timeout=10)
            assert event and event["params"]["state"] == "exited", f"no exit event: {event}"
            print("exit event ok:", event["params"])

            # cwd 继承路径的参数面：合法目录被接受（响应无直接回显，用 list+事件
            # 之外的方式难以观察；这里只断言非法值不致命——上面 start 已带非法
            # cwd 且会话成功创建）。
            print("LOCAL TERMINAL SMOKE PASS")
            return 0
        finally:
            client.close()


if __name__ == "__main__":
    raise SystemExit(main())
