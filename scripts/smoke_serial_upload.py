#!/usr/bin/env python3
"""Serial upload smoke (XMODEM/YMODEM/ZMODEM, NyaTerm parity P0-3).

真串口在 CI/容器环境不可得，本脚本按任务约定分两层：

1. 注册与校验层（始终可跑）：对不存在的 session 调 serial/upload/start、
   serial/upload/data、serial/upload/cancel，断言拿到的是业务错误
   （"session not found" / 参数校验）而非 Method not found；方法未注册时
   按 smoke 惯例记 SKIP 而非 FAIL。

2. PTY 对回环层（python 内置 pty，无需 socat）：openpty 一对伪终端，
   sidecar 打开 slave 路径，本脚本持 master 扮演串口对端。macOS 上
   serialport-rs 对伪终端报 ENOTTY，该层会按环境记 SKIP（Linux 串口驱动
   或许可跑通）：
   - XMODEM（CRC 模式）接收器：'C' 握手 → 逐块校验/ACK（坏块 NAK 触发
     重传）→ EOT 先 NAK 再 ACK 双确认；文件字节经 serial/upload/start +
     serial/upload/data 分块送入，收集 serial/upload/progress 事件直至
     complete；
   - ZMODEM 取消路径：确认 sidecar 发出 ZRQINIT(hex) 帧前导 `**\\x18B`，
     cancel 后读到 ZDLE×5+BS×5 取消序列且事件落 failed。

   无伪终端（或 raw 模式设置失败）时该层记 SKIP 并说明理由：三协议状态机的
   完整语义（正常流 / NAK 重传 / CAN 取消 / 尾部填充 / EOF 确认 / 空闲重发 /
   流式分块闸门）由 backend/src/serial_xmodem.rs 单测以"喂字节断言输出"的
   进程内模拟对端形式覆盖，真口回环仅为环境允许时的补充。

Usage:
    python3 scripts/smoke_serial_upload.py
    DBX_PLUGIN_SIDECAR=/path/to/dbx-plugin-ssh python3 scripts/smoke_serial_upload.py
"""

from __future__ import annotations

import argparse
import base64
import os
import re
import struct
import sys
import threading
import time

sys.path.insert(0, str(os.path.dirname(os.path.abspath(__file__))))
from sidecar_client import SidecarClient, SidecarError  # noqa: E402

SOH = 0x01
EOT = 0x04
ACK = 0x06
NAK = 0x15


def step(name: str):
    print(f"\n==> {name}")


class SkipSignal(Exception):
    """环境性跳过（非失败）。"""


def missing_method(error: Exception) -> str | None:
    text = str(error)
    if "Method not found" not in text and "-32601" not in text:
        return None
    match = re.search(r"Method not found:\s*([\w./-]+)", text)
    return match.group(1) if match else ""


def crc16_xmodem(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


class Report:
    def __init__(self):
        self.passed: list[str] = []
        self.skipped: list[tuple[str, str]] = []
        self.failed: list[tuple[str, str]] = []

    def run(self, title: str, case) -> None:
        step(title)
        try:
            case()
        except SkipSignal as reason:
            print(f"SKIP: {reason}")
            self.skipped.append((title, str(reason)))
        except SidecarError as error:
            missing = missing_method(error)
            if missing is not None:
                print(f"SKIP: {missing or 'method'} not registered yet")
                self.skipped.append((title, f"{missing} not registered yet"))
            else:
                print(f"FAIL: {error}")
                self.failed.append((title, str(error)))
        except Exception as error:  # noqa: BLE001
            print(f"FAIL: {error}")
            self.failed.append((title, str(error)))
        else:
            print("    PASS")
            self.passed.append(title)


def expect_business_error(client: SidecarClient, method: str, params: dict, needle: str) -> None:
    """请求应失败且原因含 needle（业务校验），而非方法未注册。"""
    try:
        client.request(method, params)
    except SidecarError as error:
        if missing_method(error) is not None:
            raise
        text = str(error)
        if needle not in text:
            raise AssertionError(f"{method} error mismatch: {text}") from error
        print(f"    {method} -> {text[:96]}...")
        return
    raise AssertionError(f"{method} unexpectedly succeeded")


# —— PTY 对回环（python 内置 pty，无需 socat）—————————————————————


def start_pty_pair() -> tuple[int, int, str]:
    """openpty 一对：sidecar 打开 slave 路径，本脚本持 master 收发。

    Python 侧刻意保持 slave fd 打开以设置 raw 终端属性（关回显，避免
    master 写入的字节被回显污染接收流）；sidecar 通过路径再次打开 slave。
    """
    import pty
    import termios
    import tty

    master, slave = pty.openpty()
    try:
        tty.setraw(slave)
        termios.tcflush(master, termios.TCIFLUSH)
    except Exception:  # noqa: BLE001
        os.close(master)
        os.close(slave)
        raise SkipSignal("PTY raw 模式设置失败（伪终端可能受环境限制）")
    return master, slave, os.ttyname(slave)


def read_exact(fd: int, count: int, timeout: float) -> bytes:
    buffer = b""
    deadline = time.monotonic() + timeout
    while len(buffer) < count:
        if time.monotonic() > deadline:
            raise TimeoutError(f"timeout reading {count} bytes (got {len(buffer)})")
        try:
            buffer += os.read(fd, count - len(buffer))
        except BlockingIOError:
            time.sleep(0.005)
    return buffer


def xmodem_receiver(fd: int, payload: bytes, done: threading.Event) -> None:
    """XMODEM-CRC 接收器：'C' 握手 → 校验每块并 ACK（坏块 NAK）→ EOT 双确认。"""
    try:
        # 握手：周期性 'C' 直到第一个 SOH。
        while True:
            os.write(fd, b"C")
            try:
                head = read_exact(fd, 1, 0.2)
            except TimeoutError:
                continue
            if head == bytes([SOH]):
                break
            raise AssertionError(f"expected SOH after handshake, got {head!r}")
        received = bytearray()
        while True:
            rest = read_exact(fd, 1 + 1 + 128 + 2, 5.0)  # seq/!seq/128B/CRC16
            seq, seq_inv = rest[0], rest[1]
            body = rest[2:-2]
            (crc,) = struct.unpack(">H", rest[-2:])
            if seq_inv != 255 - seq or crc != crc16_xmodem(body):
                os.write(fd, bytes([NAK]))  # 引擎应重发同一块
                continue
            received += body
            os.write(fd, bytes([ACK]))
            if len(received) >= len(payload):
                break
        # EOT 双确认（先 NAK 再 ACK，lrzsz 风格）。
        eot = read_exact(fd, 1, 5.0)
        if eot != bytes([EOT]):
            raise AssertionError(f"expected EOT, got {eot!r}")
        os.write(fd, bytes([NAK]))
        eot2 = read_exact(fd, 1, 5.0)
        if eot2 != bytes([EOT]):
            raise AssertionError(f"expected EOT retry, got {eot2!r}")
        os.write(fd, bytes([ACK]))
    finally:
        done.set()


def drain_progress(client: SidecarClient, progress: list[dict], seconds: float) -> None:
    """用轻量 serial/list 请求持续 pump 通知窗口，直至 complete 或超时。"""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        client.request("serial/list", {}, timeout=2.0)
        for event in client.events:
            if event.get("method") == "serial/upload/progress":
                if event not in progress:
                    progress.append(event)
        if any(event["params"].get("state") == "complete" for event in progress):
            return
        time.sleep(0.05)


def collect_progress(event: dict, sink: list[dict]) -> None:
    if event.get("method") == "serial/upload/progress":
        sink.append(event)


def open_serial_session(client: SidecarClient, port: str) -> str:
    try:
        started = client.request(
            "serial/start",
            {"port_name": port, "baud_rate": 115200, "workbench_id": "smoke-serial-upload"},
            timeout=15.0,
        )
    except SidecarError as error:
        # macOS 的 serialport-rs 对伪终端 ioctl（modem 线路）报 ENOTTY，
        # 串口回环在该平台需要真串口；协议语义由 serial_xmodem.rs 单测覆盖。
        if "typewriter" in str(error) or "ENOTTY" in str(error):
            raise SkipSignal(
                "serialport-rs 拒绝伪终端（ENOTTY \"Not a typewriter\"），"
                "回环需真串口；协议语义由 backend/src/serial_xmodem.rs 单测覆盖"
            ) from error
        raise
    session_id = str(started.get("sessionId") or "")
    if not session_id:
        raise AssertionError(f"serial/start returned no sessionId: {started}")
    return session_id


def run_xmodem_loop(client: SidecarClient, master: int, slave: int, port_a: str) -> None:
    del slave
    session_id = ""
    progress: list[dict] = []
    try:
        payload = bytes(range(256)) * 3 + b"tail!"  # 773B → 6 满块 + 1 尾块填充
        session_id = open_serial_session(client, port_a)

        done = threading.Event()
        worker = threading.Thread(target=xmodem_receiver, args=(master, payload, done), daemon=True)
        worker.start()

        client.request(
            "serial/upload/start",
            {"sessionId": session_id, "protocol": "xmodem", "fileName": "smoke.bin", "totalSize": len(payload)},
            on_event=lambda event: collect_progress(event, progress),
        )
        chunk = 256
        for offset in range(0, len(payload), chunk):
            part = payload[offset:offset + chunk]
            client.request(
                "serial/upload/data",
                {
                    "sessionId": session_id,
                    "dataBase64": base64.b64encode(part).decode(),
                    "final": offset + chunk >= len(payload),
                },
                on_event=lambda event: collect_progress(event, progress),
            )
        drain_progress(client, progress, 20.0)
        if not done.wait(timeout=25.0):
            raise AssertionError("receiver did not finish the XMODEM exchange")
        states = [str(event["params"].get("state")) for event in progress]
        if "complete" not in states:
            raise AssertionError(f"no complete progress event; states seen: {states}")
        if "failed" in states:
            reasons = [event["params"].get("reason") for event in progress if event["params"].get("state") == "failed"]
            raise AssertionError(f"unexpected failure events: {reasons}")
        print(f"    XMODEM loop complete; progress states: {states}")
    finally:
        if session_id:
            try:
                client.request("serial/close", {"sessionId": session_id})
            except Exception:  # noqa: BLE001
                pass
        os.close(master)


def run_zmodem_cancel(client: SidecarClient, master: int, slave: int, port_a: str) -> None:
    del slave
    session_id = ""
    progress: list[dict] = []
    try:
        session_id = open_serial_session(client, port_a)
        client.request(
            "serial/upload/start",
            {"sessionId": session_id, "protocol": "zmodem", "fileName": "smoke.bin", "totalSize": 10},
            on_event=lambda event: collect_progress(event, progress),
        )
        header = read_exact(master, 4, 5.0)
        if header != b"**\x18B":
            raise AssertionError(f"expected hex ZRQINIT start `**\\x18B`, got {header!r}")
        client.request(
            "serial/upload/cancel",
            {"sessionId": session_id},
            on_event=lambda event: collect_progress(event, progress),
        )
        cancel = read_exact(master, 10, 5.0)
        if cancel != b"\x18" * 5 + b"\x08" * 5:
            raise AssertionError(f"expected ZDLE*5+BS*5 cancel sequence, got {cancel!r}")
        drain_progress(client, progress, 3.0)
        states = [str(event["params"].get("state")) for event in progress]
        if "failed" not in states:
            raise AssertionError(f"no failed progress event; states seen: {states}")
        print(f"    ZMODEM cancel verified; progress states: {states}")
    finally:
        if session_id:
            try:
                client.request("serial/close", {"sessionId": session_id})
            except Exception:  # noqa: BLE001
                pass
        os.close(master)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--sidecar",
        default=os.environ.get("DBX_PLUGIN_SIDECAR"),
        help="sidecar binary path (defaults to sidecar_client discovery)",
    )
    args = parser.parse_args()

    client = SidecarClient.start(binary=args.sidecar)
    report = Report()
    try:
        # —— 第 1 层：注册与校验（无串口环境也可跑） ——————————————
        report.run(
            "upload/start rejects unknown session with a business error",
            lambda: expect_business_error(
                client,
                "serial/upload/start",
                {"sessionId": "no-such-session", "protocol": "xmodem", "fileName": "a.bin", "totalSize": 1},
                "not found",
            ),
        )
        report.run(
            "upload/data rejects unknown session with a business error",
            lambda: expect_business_error(
                client,
                "serial/upload/data",
                {"sessionId": "no-such-session", "dataBase64": "AA==", "final": True},
                "not found",
            ),
        )
        report.run(
            "upload/cancel rejects unknown session like serial/close",
            lambda: expect_business_error(
                client,
                "serial/upload/cancel",
                {"sessionId": "no-such-session"},
                "not found",
            ),
        )
        report.run(
            "upload/start validates protocol spelling (zmodem, not zodem)",
            lambda: expect_business_error(
                client,
                "serial/upload/start",
                {"sessionId": "no-such-session", "protocol": "zodem", "fileName": "a.bin", "totalSize": 1},
                "invalid protocol",
            ),
        )
        report.run(
            "upload/start enforces the 256 MiB total cap",
            lambda: expect_business_error(
                client,
                "serial/upload/start",
                {"sessionId": "no-such-session", "protocol": "xmodem", "fileName": "a.bin", "totalSize": 256 * 1024 * 1024 + 1},
                "exceeds",
            ),
        )

        # —— 第 2 层：PTY 对回环（可选，需 socat） ————————————————
        report.run(
            "XMODEM full loop over a pty pair",
            lambda: run_xmodem_loop(client, *start_pty_pair()),
        )
        report.run(
            "ZMODEM ZRQINIT + cancel sequence over a pty pair",
            lambda: run_zmodem_cancel(client, *start_pty_pair()),
        )
    finally:
        client.close()

    print("\n==== summary ====")
    for title in report.passed:
        print(f"PASS: {title}")
    for title, reason in report.skipped:
        print(f"SKIP: {title} ({reason})")
    for title, reason in report.failed:
        print(f"FAIL: {title} ({reason})")
    if report.failed:
        sys.exit(1)
    print(f"\n{len(report.passed)} passed, {len(report.skipped)} skipped, {len(report.failed)} failed")


if __name__ == "__main__":
    main()
