#!/usr/bin/env python3
"""End-to-end smoke test for login-time MFA over keyboard-interactive
(JumpServer / koko style) against a real sidecar binary.

Why a mock server instead of the usual docker container: koko 的登录流程是
"密码/公钥先被接受（partial success），再用 keyboard-interactive 问 MFA"，
容器里的 OpenSSH 构造不出这个形状（Alpine 镜像没有可用的 KI 设备/PAM 栈）。
因此本脚本用 paramiko 在本机起一个忠实复刻 koko 提问文案的 mock 堡垒机，
逐场景驱动真 sidecar（sidecar_client.py 的 stdio 协议）。

场景（对应 issue #17 / #30 的反馈；mock 服务端按 shape 参数化，覆盖四种提问形态）：
  1. 密码方法 + partial success + TOTP + 先密码再 OTP   -> 登录成功，MFA 收到验证码
  2. #30 的错配（"OTP Code" 填进密码提示词）            -> 仍必须回验证码，绝不回登录密码
  3. 私钥 + MFA（publickey partial success）            -> 登录成功
  4. 2FA 流程关闭（off）                                -> 失败，且错误信息点名服务器提问
  5. KI 里先问密码（PAM 风格）+ sudo 口令不同           -> 登录提问收到登录口令而非 sudo 口令
  6. 只问 MFA（反问顺序主机）+ 先密码再 OTP             -> 失败且不回码（保护仍生效）
  7. 只问 MFA + 密码 + OTP 合并模式                     -> 登录成功
  8. 一条合并提问（密码与验证码同一行）+ 合并模式       -> 应答为登录口令 + 验证码
  9. global 全局 Quick Sudo 配置提供登录期 MFA 凭据     -> 登录成功

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
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError, lifecycle_params
from sidecar_client import default_binary

try:
    import paramiko
except ImportError:  # pragma: no cover - depends on the dev environment
    paramiko = None

LOGIN_PASSWORD = "DbxJumpPw"
SUDO_PASSWORD = "AssetPw"
MFA_CODE = "654321"  # 静态码：确定性，不依赖时钟/真实 TOTP 密钥
MFA_INSTRUCTION = "Please Enter MFA Code."  # koko mfaOptionInstruction
MFA_QUESTION = "[OTP Code]: "  # koko mfaOptionQuestion（MFA 类型 otp）
MFA_ROUNDS_BEFORE_GIVING_UP = 6

# mock 堡垒机的认证形态（与 backend/src/ssh.rs 的 koko_login::Shape 对应）。
PASSWORD_THEN_MFA = "password_then_mfa"
KI_PASSWORD_THEN_MFA = "ki_password_then_mfa"
KI_MFA_ONLY = "ki_mfa_only"
KI_COMBINED = "ki_combined"


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

    def __init__(self, shape: str, instruction: str = MFA_INSTRUCTION, prompt: str = MFA_QUESTION) -> None:
        self.shape = shape
        self.instruction = instruction
        self.prompt = prompt
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
                self.round = 0

            def check_auth_password(self, username, password):
                if outer.shape == PASSWORD_THEN_MFA and password == LOGIN_PASSWORD:
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
                if outer.shape == PASSWORD_THEN_MFA:
                    return "password,publickey,keyboard-interactive"
                # 只开 KI 的形态：客户端走 keyboard-interactive 分支
                return "keyboard-interactive"

            def check_auth_interactive(self, username, submethods):
                self.username = username
                if outer.shape == KI_PASSWORD_THEN_MFA:
                    return paramiko.InteractiveQuery(
                        username, "Please enter your password.", ("Password: ", False)
                    )
                if outer.shape == KI_COMBINED:
                    return paramiko.InteractiveQuery(
                        username, "Password and MFA required", ("Password: OTP Code: ", False)
                    )
                return paramiko.InteractiveQuery(
                    username, outer.instruction, (outer.prompt, True)
                )

            def check_auth_interactive_response(self, responses):
                answer = responses[0] if responses else ""
                outer.record(answer)
                self.round += 1
                if outer.shape == KI_PASSWORD_THEN_MFA and self.round == 1:
                    # 第一轮是密码：答对后继续问 MFA。
                    if answer != LOGIN_PASSWORD:
                        return paramiko.AUTH_FAILED
                    return paramiko.InteractiveQuery(
                        self.username, outer.instruction, (outer.prompt, True)
                    )
                if outer.shape == KI_COMBINED:
                    expected = f"{LOGIN_PASSWORD}{MFA_CODE}"
                    return paramiko.AUTH_SUCCESSFUL if answer == expected else paramiko.AUTH_FAILED
                if answer == MFA_CODE:
                    return paramiko.AUTH_SUCCESSFUL
                if answer == "":
                    # koko 对空应答会重新提问；这里限次后收尾，避免测试挂死。
                    outer._rounds[session_id] = outer._rounds.get(session_id, 0) + 1
                    if outer._rounds[session_id] < MFA_ROUNDS_BEFORE_GIVING_UP:
                        return paramiko.InteractiveQuery(
                            self.username, outer.instruction, (outer.prompt, True)
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


def run_scenario(
    binary: str,
    shape: str,
    secrets: dict,
    external: dict,
    instruction: str = MFA_INSTRUCTION,
    prompt: str = MFA_QUESTION,
    prepare=None,
) -> tuple[bool, str, list[str]]:
    """Returns (ok, message, answers the mock received, in order)."""
    server = MockKoko(shape, instruction, prompt)
    client = None
    try:
        client = SidecarClient.start(
            binary, data_dir=tempfile.mkdtemp(prefix="dbx-login-mfa-"), timeout=45
        )
        client.initialize()
        if prepare is not None:
            prepare(client)
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


def save_global_profile(client: SidecarClient) -> None:
    """Global Quick Sudo profile carrying the login MFA credentials."""
    client.request(
        "sudo/profiles/save",
        {
            "name": "ops",
            "sudoPassword": SUDO_PASSWORD,
            "totpSecret": MFA_CODE,
            "authFlowMode": "password_then_otp",
        },
    )


@dataclass
class Scenario:
    title: str
    shape: str
    secrets: dict
    external: dict
    expect_ok: bool
    expect_answers: list[str] | None = None
    error_contains: str | None = None
    instruction: str = MFA_INSTRUCTION
    prompt: str = MFA_QUESTION
    needs_key: bool = False
    prepare: object = None
    extra: dict = field(default_factory=dict)


def scenario_matrix() -> list[Scenario]:
    totp = {"totp_secret": MFA_CODE}
    password_then_otp = {"authentication": "password", "auth_flow_mode": "password_then_otp"}
    return [
        Scenario(
            "1. password 方法 + TOTP（先密码再 OTP）",
            PASSWORD_THEN_MFA,
            dict(totp),
            dict(password_then_otp),
            True,
            expect_answers=[MFA_CODE],
        ),
        Scenario(
            "2. issue #30 错配：\"OTP Code\" 填进密码提示词",
            PASSWORD_THEN_MFA,
            dict(totp),
            {**password_then_otp, "password_prompt_hint": "OTP Code"},
            True,
            expect_answers=[MFA_CODE],
        ),
        Scenario(
            "3. 私钥 + MFA（publickey partial success）",
            PASSWORD_THEN_MFA,
            dict(totp),
            {"authentication": "private-key", "auth_flow_mode": "password_then_otp"},
            True,
            expect_answers=[MFA_CODE],
            needs_key=True,
        ),
        Scenario(
            "4. auth_flow_mode=off：不回码，但错误必须点名服务器提问",
            PASSWORD_THEN_MFA,
            dict(totp),
            {"authentication": "password", "auth_flow_mode": "off"},
            False,
            error_contains=MFA_QUESTION.strip(),
        ),
        Scenario(
            "5. KI 里先问密码（PAM 风格）+ sudo 口令不同：登录提问用登录口令",
            KI_PASSWORD_THEN_MFA,
            {**totp, "sudo_password": SUDO_PASSWORD},
            dict(password_then_otp),
            True,
            expect_answers=[LOGIN_PASSWORD, MFA_CODE],
        ),
        Scenario(
            "6. 只问 MFA（反问顺序）+ 先密码再 OTP：不回码且点名提问",
            KI_MFA_ONLY,
            dict(totp),
            dict(password_then_otp),
            False,
            error_contains=MFA_QUESTION.strip(),
        ),
        Scenario(
            "7. 只问 MFA + 密码与 OTP 合并模式：可登录",
            KI_MFA_ONLY,
            dict(totp),
            {"authentication": "password", "auth_flow_mode": "password_plus_otp"},
            True,
            expect_answers=[MFA_CODE],
        ),
        Scenario(
            "8. 一条合并提问（密码与验证码同行）+ 合并模式",
            KI_COMBINED,
            dict(totp),
            {"authentication": "password", "auth_flow_mode": "password_plus_otp"},
            True,
            expect_answers=[f"{LOGIN_PASSWORD}{MFA_CODE}"],
        ),
        Scenario(
            "9. global 全局 Quick Sudo 配置提供登录期 MFA",
            PASSWORD_THEN_MFA,
            {},
            {
                "authentication": "password",
                "sudo_source": "global",
                "sudo_profile": "ops",
            },
            True,
            expect_answers=[MFA_CODE],
            prepare=save_global_profile,
        ),
        Scenario(
            "10. 提问文案靠挑战指令行（koko 的 Please Enter MFA Code.）命中",
            PASSWORD_THEN_MFA,
            dict(totp),
            {
                **password_then_otp,
                "totp_prompt_hint": MFA_INSTRUCTION,
            },
            True,
            expect_answers=[MFA_CODE],
            prompt="Code: ",
        ),
    ]


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

    key_path = Path(tempfile.mkdtemp(prefix="dbx-login-mfa-key-")) / "id_rsa"
    paramiko.RSAKey.generate(2048).write_private_key_file(str(key_path))
    key_text = key_path.read_text()

    for scenario in scenario_matrix():
        payload_secrets = dict(scenario.secrets)
        if scenario.needs_key:
            payload_secrets["private_key"] = key_text
        try:
            ok, message, answers = run_scenario(
                binary,
                scenario.shape,
                payload_secrets,
                scenario.external,
                instruction=scenario.instruction,
                prompt=scenario.prompt,
                prepare=scenario.prepare,
            )
        except SidecarError as exc:
            report.note_skip(scenario.title, f"sidecar unavailable: {exc}")
            continue
        if not ok and is_method_missing(message):
            report.note_skip(scenario.title, "connection/test not registered (older sidecar)")
            continue

        if scenario.expect_ok:
            if not ok:
                report.note_fail(scenario.title, f"login failed: {message}")
                continue
            if scenario.expect_answers is not None and answers != scenario.expect_answers:
                report.note_fail(
                    scenario.title,
                    f"answers were {answers!r}, expected {scenario.expect_answers!r}",
                )
                continue
            report.note_pass(scenario.title)
        else:
            if ok:
                report.note_fail(scenario.title, "expected the login to fail")
                continue
            if scenario.error_contains and scenario.error_contains not in message:
                report.note_fail(
                    scenario.title,
                    f"error message does not name the server prompt: {message}",
                )
                continue
            if any(answer == MFA_CODE for answer in answers):
                report.note_fail(
                    scenario.title, "OTP was answered although the flow mode is off"
                )
                continue
            report.note_pass(scenario.title)

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
