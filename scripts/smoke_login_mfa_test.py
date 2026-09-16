#!/usr/bin/env python3
"""End-to-end smoke test for login-time MFA over keyboard-interactive
(JumpServer / koko style) against a real sidecar binary.

Why a mock server instead of the usual docker container: koko 的登录流程是
"密码/公钥先被接受（partial success），再用 keyboard-interactive 问 MFA"，
容器里的 OpenSSH 构造不出这个形状（Alpine 镜像没有可用的 KI 设备/PAM 栈）。
因此本脚本用 paramiko 在本机起一个忠实复刻 koko 提问文案的 mock 堡垒机，
逐场景驱动真 sidecar（sidecar_client.py 的 stdio 协议）。

场景（对应 issue #17 / #30 的反馈）：
  1. 密码 + TOTP 密钥 + 先密码再 OTP        -> 登录成功，MFA 收到验证码
  2. #30 的错配（"OTP Code" 填进密码提示词）-> 仍必须回验证码，绝不回登录密码
  3. 私钥 + MFA（publickey partial success） -> 登录成功
  4. 2FA 流程关闭（off）                     -> 失败，且错误信息点名服务器提问

paramiko 未安装、或旧 sidecar 未注册 `connection/test` 时 SKIP（不判失败）。
主机密钥/私钥均为本机运行时生成，不涉及任何真实凭据或生产主机。

Usage:
    DBX_PLUGIN_SIDECAR=backend/target/release/dbx-plugin-ssh \\
        python3 scripts/smoke_login_mfa_test.py
    python3 scripts/smoke_login_mfa_test.py --binary backend/target/debug/dbx-plugin-ssh
"""

from __future__ import annotations

import argparse
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError, lifecycle_params
from sidecar_client import default_binary

try:
    import paramiko
except ImportError:  # pragma: no cover - depends on the dev environment
    paramiko = None

LOGIN_PASSWORD = "DbxJumpPw"
MFA_CODE = "654321"  # 静态码：确定性，不依赖时钟/真实 TOTP 密钥
MFA_INSTRUCTION = "Please Enter MFA Code."  # koko mfaOptionInstruction
MFA_QUESTION = "[OTP Code]: "  # koko mfaOptionQuestion（MFA 类型 otp）
MFA_ROUNDS_BEFORE_GIVING_UP = 6


class Report:
    def __init__(self) -> None:
        self.passed: list[str] = []
        self.skipped: list[tuple[str, str]] = []
        self.failed: list[tuple[str, str]] = []

    def note_pass(self, title: str) -> None:
        self.passed.append(title)
        print(f"  PASS: {title}")

    def note_skip(self, title: str, reason: str) -> None:
        self.skipped.append((title, reason))
        print(f"  SKIP: {title} — {reason}")

    def note_fail(self, title: str, reason: str) -> None:
        self.failed.append((title, reason))
        print(f"  FAIL: {title} — {reason}")


class MockKoko:
    """One mock JumpServer/koko auth server per scenario (ephemeral port)."""

    def __init__(self) -> None:
        self.host_key = paramiko.RSAKey.generate(2048)
        self.answers: list[str] = []
        self._lock = threading.Lock()
        self._sessions = 0
        self._rounds: dict[int, int] = {}
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(4)
        self.port = self._sock.getsockname()[1]
        self._stopped = False
        threading.Thread(target=self._accept_loop, daemon=True).start()

    # -- plumbing ------------------------------------------------------------
    def record(self, answer: str) -> None:
        with self._lock:
            self.answers.append(answer)

    def take_answers(self) -> list[str]:
        with self._lock:
            return list(self.answers)

    def _accept_loop(self) -> None:
        while not self._stopped:
            try:
                client, _ = self._sock.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(client,), daemon=True).start()

    def _serve(self, client: socket.socket) -> None:
        with self._lock:
            self._sessions += 1
            session_id = self._sessions
        transport = paramiko.Transport(client)
        transport.add_server_key(self.host_key)
        try:
            transport.start_server(server=self._interface(session_id))
        except Exception:  # noqa: BLE001 - mock harness
            pass

    def stop(self) -> None:
        self._stopped = True
        try:
            self._sock.close()
        except OSError:
            pass

    # -- koko-faithful auth shape -------------------------------------------
    def _interface(self, session_id: int):
        outer = self

        class Interface(paramiko.ServerInterface):
            def __init__(self) -> None:
                self.partial = False
                self.username = "jumper"

            def check_auth_password(self, username, password):
                if password == LOGIN_PASSWORD:
                    # koko: 第一因子通过 → PartialSuccessError(KeyboardInteractive)
                    self.partial = True
                    return paramiko.AUTH_PARTIALLY_SUCCESSFUL
                return paramiko.AUTH_FAILED

            def check_auth_publickey(self, username, key):
                # koko 的私钥 + MFA：公钥本身接受，仍要二次认证。
                self.partial = True
                return paramiko.AUTH_PARTIALLY_SUCCESSFUL

            def get_allowed_auths(self, username):
                if self.partial:
                    return "keyboard-interactive"
                return "password,publickey,keyboard-interactive"

            def check_auth_interactive(self, username, submethods):
                self.username = username
                return paramiko.InteractiveQuery(
                    username, MFA_INSTRUCTION, (MFA_QUESTION, True)
                )

            def check_auth_interactive_response(self, responses):
                answer = responses[0] if responses else ""
                outer.record(answer)
                if answer == MFA_CODE:
                    return paramiko.AUTH_SUCCESSFUL
                if answer == "":
                    # koko 对空应答会重新提问；这里限次后收尾，避免测试挂死。
                    outer._rounds[session_id] = outer._rounds.get(session_id, 0) + 1
                    if outer._rounds[session_id] < MFA_ROUNDS_BEFORE_GIVING_UP:
                        return paramiko.InteractiveQuery(
                            self.username, MFA_INSTRUCTION, (MFA_QUESTION, True)
                        )
                return paramiko.AUTH_FAILED

        return Interface()


def auto_accept_challenge(event: dict) -> dict | None:
    """Resolve the plugin's host-key challenge while a request is in flight."""
    if event.get("method") != "connection/challenge":
        return None
    params = event.get("params") or {}
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


def connection_payload(port: int, secrets: dict, external: dict) -> dict:
    return {
        "id": "login-mfa-smoke",
        "name": "login-mfa-smoke",
        "db_type": "ssh",
        "host": "127.0.0.1",
        "port": port,
        "username": "jumper",
        "password": LOGIN_PASSWORD,
        "connection_secrets": secrets,
        "external_config": external,
    }


def run_scenario(binary: str, secrets: dict, external: dict) -> tuple[bool, str, list[str]]:
    """Returns (ok, message, mfa answers the mock received)."""
    server = MockKoko()
    client = None
    try:
        client = SidecarClient.start(
            binary, data_dir=tempfile.mkdtemp(prefix="dbx-login-mfa-"), timeout=45
        )
        client.initialize()
        try:
            client.request(
                "connection/test",
                lifecycle_params(connection_payload(server.port, secrets, external)),
                timeout=45,
                on_event=auto_accept_challenge,
            )
            ok, message = True, "connection/test succeeded"
        except SidecarError as exc:
            ok, message = False, str(exc)
        answers = server.take_answers()
        return ok, message, answers
    finally:
        if client is not None:
            # sidecar 退出后才能读 stderr（否则 read() 会一直阻塞）。
            client.close()
        server.stop()


def is_method_missing(message: str) -> bool:
    lowered = message.lower()
    return "not registered" in lowered or "method not found" in lowered or "unknown method" in lowered


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default=None, help="sidecar binary (default: DBX_PLUGIN_SIDECAR)")
    args = parser.parse_args()

    print("login-time MFA (keyboard-interactive) smoke")
    if paramiko is None:
        print("SKIP: paramiko not installed — pip install paramiko to run the mock koko server")
        return

    binary = args.binary or default_binary()
    if not Path(binary).exists():
        print(f"SKIP: sidecar binary not found: {binary} (set DBX_PLUGIN_SIDECAR)")
        return
    report = Report()
    started = time.monotonic()

    scenarios = [
        (
            "1. password + TOTP, password_then_otp",
            {"totp_secret": MFA_CODE},
            {"authentication": "password", "auth_flow_mode": "password_then_otp"},
            True,
        ),
        (
            "2. issue #30 错配：\"OTP Code\" 填进密码提示词",
            {"totp_secret": MFA_CODE},
            {
                "authentication": "password",
                "auth_flow_mode": "password_then_otp",
                "password_prompt_hint": "OTP Code",
            },
            True,
        ),
        (
            "3. private key + MFA",
            {},
            {"authentication": "private-key", "auth_flow_mode": "password_then_otp"},
            True,
        ),
        (
            "4. auth_flow_mode=off 不自动回码，但必须点名服务器提问",
            {"totp_secret": MFA_CODE},
            {"authentication": "password", "auth_flow_mode": "off"},
            False,
        ),
    ]

    key_path = Path(tempfile.mkdtemp(prefix="dbx-login-mfa-key-")) / "id_rsa"
    paramiko.RSAKey.generate(2048).write_private_key_file(str(key_path))
    key_text = key_path.read_text()

    for title, secrets, external, expect_success in scenarios:
        payload_secrets = dict(secrets)
        if external["authentication"] == "private-key":
            payload_secrets = {**payload_secrets, "private_key": key_text}
            # 私钥场景也要配 TOTP：MFA 提问必须自动应答。
            payload_secrets["totp_secret"] = MFA_CODE
        try:
            ok, message, answers = run_scenario(binary, payload_secrets, external)
        except SidecarError as exc:
            report.note_skip(title, f"sidecar unavailable: {exc}")
            continue
        if not ok and is_method_missing(message):
            report.note_skip(title, "connection/test not registered (older sidecar)")
            continue

        if expect_success:
            if not ok:
                report.note_fail(title, f"login failed: {message}")
                continue
            if answers != [MFA_CODE]:
                report.note_fail(
                    title,
                    f"MFA answers were {answers!r}, expected [{MFA_CODE!r}]",
                )
                continue
            if LOGIN_PASSWORD in answers:
                report.note_fail(title, "login password was submitted as the MFA answer")
                continue
            report.note_pass(title)
        else:
            if ok:
                report.note_fail(title, "expected the login to fail without OTP answering")
                continue
            if MFA_QUESTION.strip() not in message:
                report.note_fail(
                    title,
                    f"error message does not name the server prompt: {message}",
                )
                continue
            if any(answer == MFA_CODE for answer in answers):
                report.note_fail(title, "OTP was answered although the flow mode is off")
                continue
            report.note_pass(title)

    elapsed = time.monotonic() - started
    print(
        f"\n==== login MFA smoke summary: {len(report.passed)} passed, "
        f"{len(report.skipped)} skipped, {len(report.failed)} failed ({elapsed:.1f}s) ===="
    )
    if report.failed:
        sys.exit(1)
    print("login MFA smoke: all green")


if __name__ == "__main__":
    main()
