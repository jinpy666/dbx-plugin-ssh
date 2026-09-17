#!/usr/bin/env python3
"""End-to-end smoke test for Quick Sudo keepalive and TOTP anti-replay
semantics (enhancement item 5) against a real SSH container.

Verified chain, per docs/PROTOCOL.zh-CN.md "Quick Sudo":
  1. password-only quick sudo executes and registers the per-connection
     `sudo -nv` keepalive loop (ssh/sessions/list sudoKeepalive);
  2. a cached sudo timestamp answers a later sudo exec without a password
     prompt (proven by deliberately configuring a wrong password);
  3. after `sudo -k` the wrong password fails with the auth-failure marker;
  4. ssh/settings/set registers TOTP secrets without ever echoing them back;
  5. the current-window RFC 6238 code (computed host-side, standard library
     only) is auto-submitted for the OTP prompt and accepted;
  6. a second sudo in the same window rotates to the next configured secret
     instead of replaying the committed code (the emulated server rejects the
     rotated code and the submission log proves which code was sent);
  7. a third attempt hard-skips OTP submission entirely (no new log entry);
  8. a wrong TOTP secret fails authentication.

Container strategy (see docs/PROGRESS-XE.zh-CN.md): Alpine's sudo is built
--without-pam, so no PAM TOTP module can hook into the real sudo. Instead the
test toggles the container between two modes:
  - password phase: real sudo with a password-required sudoers entry and
    timestamp_type=global (runtime-generated credentials via chpasswd);
  - OTP phase: a POSIX shell shim earlier in PATH emulates the OTP-prompting
    sudo front end (prompts "Verification code:", compares the submitted code
    against a host-written expectation, logs every submission with an
    ACCEPT/REJECT verdict) and then delegates the actual privilege escalation
    to the real /usr/bin/sudo with the piped password. The TOTP secret itself
    never reaches the container - only the ephemeral expected code does.

All cases marked SKIP on "Method not found" so the script keeps passing
against older sidecars. Secrets/codes are runtime-generated and never printed.

Usage:
    DBX_PLUGIN_SIDECAR=backend/target/release/dbx-plugin-ssh-sftp \
        python3 scripts/smoke_sudo_otp_test.py        # default test container
    python3 scripts/smoke_sudo_otp_test.py --binary PATH --host H --port P
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac as hmac_mod
import json
import re
import secrets
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError, lifecycle_params

CONTAINER = "dbx-ssh-test"
SUDOERS_ENTRY = "/etc/sudoers.d/dbx-smoke-sudo"
SUDOERS_BACKUP = "/etc/dbx-smoke-sudoers-backup"
SHIM_PATH = "/usr/local/bin/sudo"
SHIM_MARKER = "DBX-SMOKE-SUDO-SHIM"
FLAG_FILE = "/config/.dbx-otp-test.flag"
EXPECTED_FILE = "/config/.dbx-otp-test.expected"
LOG_FILE = "/tmp/dbx-otp-submissions.log"
TOTP_PERIOD = 30

# POSIX shim installed at /usr/local/bin/sudo (ahead of /usr/bin in PATH).
# Without the flag file it is a pure passthrough to the real sudo. With the
# flag file it emulates the OTP-prompting PAM front end: consumes the piped
# password line, prints a TOTP prompt, compares the submitted code with the
# host-written expectation, logs "<epoch> <code> <verdict>", then delegates
# the actual root execution to the real sudo with the piped password so
# password validation and privilege escalation stay genuine.
SHIM_SOURCE = f"""#!/bin/bash
# {SHIM_MARKER} - smoke-test sudo front end, safe to delete.
REAL=/usr/bin/sudo
FLAG={FLAG_FILE}
EXPECTED={EXPECTED_FILE}
LOG={LOG_FILE}

case "$1" in
  -nv|-v|-k|-n|-l|-V|-h) exec "$REAL" "$@" ;;
esac
# Delegate with the ORIGINAL arguments: the sidecar invokes
# `sudo -S -p '' <command>` and relies on -S reading the password from
# stdin - stripping options here would make the real sudo demand a TTY.
if [ ! -f "$FLAG" ]; then
  exec "$REAL" "$@"
fi
IFS= read -t 15 -r password_line || password_line=
printf 'Verification code:' >&2
code=
IFS= read -t 15 -r code || code=
now=$(date +%s)
expected=
[ -f "$EXPECTED" ] && expected=$(cat "$EXPECTED" 2>/dev/null)
if [ -n "$code" ] && [ "$code" = "$expected" ]; then
  echo "$now $code ACCEPT" >> "$LOG"
  printf '%s\\n' "$password_line" | "$REAL" "$@"
  exit $?
fi
echo "$now $code REJECT" >> "$LOG"
echo 'sudo: 1 incorrect password attempt' >&2
exit 1
"""


def step(name: str):
    print(f"\n==> {name}")


def mask(code: str) -> str:
    return (code[:2] + "***") if code else "<none>"


def redact(text: str) -> str:
    return re.sub(r"\b\d{6}\b", "******", text)


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
                print(f"FAIL: {redact(str(error))}")
                self.failed.append((title, redact(str(error))))
        except Exception as error:
            print(f"FAIL: {redact(str(error))}")
            self.failed.append((title, redact(str(error))))
        else:
            print("    PASS")
            self.passed.append(title)


# -- RFC 6238 (HMAC-SHA1, 30s, 6 digits), standard library only ---------------

def totp_now(secret_b32: str, at: float | None = None) -> str:
    key = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8))
    counter = int((at if at is not None else time.time()) // TOTP_PERIOD)
    digest = hmac_mod.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = ((digest[offset] & 0x7F) << 24) | (digest[offset + 1] << 16) \
        | (digest[offset + 2] << 8) | digest[offset + 3]
    return str(binary % 10**6).zfill(6)


def totp_window(secret_b32: str, window: int) -> str:
    return totp_now(secret_b32, at=window * TOTP_PERIOD + 1)


def ensure_window_margin(seconds: int = 14) -> int:
    """Sleep past the next TOTP boundary when the current window is too short,
    so the sidecar and the host-side expectation agree on one window. Returns
    the window index the caller is now in."""
    remaining = TOTP_PERIOD - (time.time() % TOTP_PERIOD)
    if remaining < seconds:
        print(f"    waiting {remaining + 0.5:.1f}s for a fresh TOTP window")
        time.sleep(remaining + 0.5)
    return int(time.time() // TOTP_PERIOD)


def new_totp_secret() -> str:
    # 20 bytes -> exactly 32 canonical base32 chars, no padding needed.
    return base64.b32encode(secrets.token_bytes(20)).decode()


# -- container preparation (idempotent) ---------------------------------------

def docker_exec(container: str, command: str, input_text: str | None = None,
                user: str | None = None, timeout: float = 30) -> subprocess.CompletedProcess:
    args = ["-u", user] if user else []
    return subprocess.run(
        ["docker", "exec", "-i", *args, container, "sh", "-c", command],
        input=input_text, capture_output=True, text=True, timeout=timeout)


class ContainerSetup:
    """Idempotent container preparation with a best-effort restore."""

    def __init__(self, container: str, login_password: str, original_password: str):
        self.container = container
        self.password = login_password
        self.original_password = original_password
        self.shim_installed = False
        self.preexisting_shim = False
        self.sudoers_touched = False
        self.notes: list[str] = []

    def _sh(self, command: str, user: str | None = None,
            input_text: str | None = None) -> subprocess.CompletedProcess:
        return docker_exec(self.container, command, input_text=input_text, user=user)

    def prepare(self) -> str | None:
        """Returns a SKIP reason on environment failure, else None."""
        try:
            probe = subprocess.run(["docker", "ps", "--format", "{{.Names}}"],
                                   capture_output=True, text=True, timeout=15)
        except FileNotFoundError:
            return "docker CLI not available"
        if probe.returncode != 0:
            return "docker ps failed"
        names = probe.stdout.split()
        if self.container not in names:
            print(f"    container {self.container} missing, creating per SKILL.md recipe")
            created = subprocess.run(
                ["docker", "run", "-d", "--name", self.container, "-p", "2222:2222",
                 "-e", "USER_NAME=sshuser", "-e", f"USER_PASSWORD={args.password}",
                 "-e", "PASSWORD_ACCESS=true",
                 "linuxserver/openssh-server"],
                capture_output=True, text=True, timeout=120)
            if created.returncode != 0:
                return f"cannot create test container: {created.stderr.strip()[:120]}"
            time.sleep(3)

        # 1. Runtime-generated credentials via chpasswd (stdin, never argv).
        if self._sh("chpasswd", input_text=f"sshuser:{self.password}\n").returncode != 0:
            return "chpasswd failed"

        # 2. Password-required sudoers with a global timestamp type, keeping
        #    the original /etc/sudoers.d contents in a backup dir. Files with
        #    a dot prefix are ignored by @includedir, so the backup lives at
        #    /etc (outside sudoers.d) and survives interrupted runs.
        if self._sh(f"test -f {SUDOERS_ENTRY}").returncode != 0:
            self.sudoers_touched = True
            if self._sh(f"mkdir -p {SUDOERS_BACKUP} && "
                        f"cp -a /etc/sudoers.d/. {SUDOERS_BACKUP}/ 2>/dev/null; "
                        f"rm -f /etc/sudoers.d/*").returncode != 0:
                return "cannot snapshot /etc/sudoers.d"
            entry = ("sshuser ALL=(ALL:ALL) ALL\n"
                     "Defaults:sshuser timestamp_type=global\n"
                     "Defaults:sshuser !lecture\n")
            result = self._sh(f"cat > {SUDOERS_ENTRY} && chmod 440 {SUDOERS_ENTRY} && visudo -c",
                              input_text=entry)
            if result.returncode != 0:
                return f"sudoers setup failed: {result.stderr.strip()[:120]}"
        else:
            self.sudoers_touched = True  # restore path still runs

        # 3. OTP shim (only needed for the OTP phase but installed once).
        exists = self._sh(f"test -f {SHIM_PATH} && grep -q {SHIM_MARKER} {SHIM_PATH}")
        if exists.returncode != 0:
            preexisting = self._sh(f"test -f {SHIM_PATH}")
            self.preexisting_shim = preexisting.returncode == 0
            if self.preexisting_shim:
                return f"{SHIM_PATH} exists and is not the smoke shim"
            result = self._sh(f"cat > {SHIM_PATH} && chmod 755 {SHIM_PATH}",
                              input_text=SHIM_SOURCE)
            if result.returncode != 0:
                return f"shim install failed: {result.stderr.strip()[:120]}"
        self.shim_installed = True

        # 4. Clean OTP-phase state.
        self._sh(f"rm -f {FLAG_FILE} {EXPECTED_FILE} {LOG_FILE}")
        return None

    def set_otp_mode(self, enabled: bool, expected_code: str | None = None) -> None:
        if enabled:
            self._sh(f"touch {FLAG_FILE} && cat > {EXPECTED_FILE} && chmod 644 {EXPECTED_FILE}",
                     user="sshuser", input_text=(expected_code or "") + "\n")
        else:
            self._sh(f"rm -f {FLAG_FILE} {EXPECTED_FILE}")

    def read_submission_log(self) -> list[tuple[str, str, str]]:
        result = self._sh(f"cat {LOG_FILE} 2>/dev/null || true")
        rows = []
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) == 3:
                rows.append((parts[0], parts[1], parts[2]))
        return rows

    def restore(self) -> None:
        if self._sh(f"rm -f {FLAG_FILE} {EXPECTED_FILE} {LOG_FILE}").returncode != 0:
            self.notes.append("OTP state files could not be removed")
        if self.shim_installed and not self.preexisting_shim:
            if self._sh(f"rm -f {SHIM_PATH}").returncode != 0:
                self.notes.append(f"{SHIM_PATH} could not be removed")
        if self.sudoers_touched:
            result = self._sh(f"rm -f /etc/sudoers.d/* && "
                              f"cp -a {SUDOERS_BACKUP}/. /etc/sudoers.d/ 2>/dev/null; "
                              f"rm -rf {SUDOERS_BACKUP}; visudo -c")
            if result.returncode != 0:
                self.notes.append(f"sudoers restore failed: {result.stderr.strip()[:120]}")
        if self._sh("chpasswd", input_text=f"sshuser:{self.original_password}\n").returncode != 0:
            self.notes.append("original container password could not be restored "
                              "(pass it via --password on the next run)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default=None)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2222)
    parser.add_argument("--user", default="sshuser")
    parser.add_argument("--password", default="DbxTest2026",
                        help="original container password (restored at exit)")
    parser.add_argument("--container", default=CONTAINER)
    args = parser.parse_args()

    started = time.monotonic()
    # Login/sudo password: runtime-generated (digits+lower+upper+symbol for
    # chpasswd), lives only in this process and the container's shadow file.
    login_password = secrets.token_urlsafe(12) + "1aA!"
    setup = ContainerSetup(args.container, login_password=login_password,
                           original_password=args.password)

    skip_all: str | None = None
    skip_otp: str | None = None
    data_dir = tempfile.mkdtemp(prefix="dbx-sudo-otp-data-")
    client = None
    report = Report()
    connection_id = "smoke-sudo-otp-connection"
    session_id = ""
    wrong_password = secrets.token_hex(16)

    try:
        step("container preparation (idempotent)")
        skip_all = setup.prepare()
        if skip_all:
            print(f"SKIP: {skip_all}")
        else:
            print(f"    container {args.container} ready; password sudo configured "
                  f"(credentials runtime-generated)")

            step("plugin/initialize")
            client = SidecarClient.start(binary=args.binary, timeout=30, data_dir=data_dir)
            info = client.initialize()
            print(json.dumps(info, ensure_ascii=False)[:200])

            connection = {
                "id": connection_id,
                "name": "smoke-sudo-otp",
                "db_type": "ssh",
                "host": args.host,
                "port": args.port,
                "username": args.user,
                "password": setup.password,
                "external_config": {"authentication": "password"},
            }
            step("connection/connect + test + session/open")
            client.request("connection/connect", lifecycle_params(connection))
            client.request("connection/test", lifecycle_params(connection), timeout=90,
                           on_event=auto_accept_challenge)
            session = client.request("ssh/session/open",
                                     {"connectionId": connection_id, "workbenchId": "smoke-sudo-otp",
                                      "cols": 120, "rows": 30},
                                     timeout=60, on_event=auto_accept_challenge)
            session_id = session.get("sessionId", "smoke-sudo-otp")
            print(f"    session {session_id} opened")

            def req(method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
                return client.request(method, params, timeout=timeout,
                                      on_event=auto_accept_challenge)

            # Point Quick Sudo at the runtime-generated sudo password.
            req("ssh/settings/set", {"sessionId": session_id, "sudoPassword": setup.password})

            # The shim must shadow the real sudo for the exec channel.
            which = req("ssh/exec", {"sessionId": session_id, "command": "command -v sudo"})
            if which.get("output") != "/usr/local/bin/sudo":
                skip_all = (f"sudo shim not shadowing (PATH resolves "
                            f"{which.get('output')!r})")
                skip_otp = skip_all
                print(f"SKIP: {skip_all}")

        if not skip_all:
            # -- phase 1: password-only quick sudo + keepalive (OTP shim idle) --

            def case_sudo_password_exec():
                req("ssh/exec", {"sessionId": session_id, "command": "sudo -k"})  # fresh state
                result = req("ssh/exec", {"sessionId": session_id, "command": "echo keep-1",
                                          "sudo": True}, timeout=120)
                if result.get("exitCode") != 0 or "keep-1" not in result.get("output", ""):
                    raise AssertionError(f"sudo exec wrong: {json.dumps(result)[:160]}")

            def case_sudo_keepalive_registered():
                listed = req("ssh/sessions/list", {}, timeout=30)
                mine = next((s for s in listed.get("sessions", [])
                             if s.get("sessionId") == session_id), None)
                if mine is None:
                    raise AssertionError("current session missing from the inventory")
                if mine.get("sudoKeepalive") is not True:
                    raise AssertionError("sudoKeepalive not registered after a successful "
                                         "sudo exec")
                print(f"    sudoKeepalive={mine.get('sudoKeepalive')}")

            def case_cached_timestamp_skips_prompt():
                # Wrong configured password + cached timestamp: sudo must not
                # prompt at all, so the command still succeeds.
                req("ssh/settings/set", {"sessionId": session_id,
                                         "sudoPassword": wrong_password})
                result = req("ssh/exec", {"sessionId": session_id, "command": "echo keep-2",
                                          "sudo": True}, timeout=120)
                if result.get("exitCode") != 0 or "keep-2" not in result.get("output", ""):
                    raise AssertionError("cached sudo timestamp did not skip the password "
                                         f"prompt: {json.dumps(result)[:160]}")

            def case_wrong_password_fails_after_reset():
                req("ssh/exec", {"sessionId": session_id, "command": "sudo -k"})
                try:
                    req("ssh/exec", {"sessionId": session_id, "command": "echo keep-3",
                                     "sudo": True}, timeout=120)
                except SidecarError as error:
                    if "sorry, try again" not in str(error).lower() \
                            and "authentication" not in str(error).lower():
                        raise AssertionError(f"unexpected failure mode: {redact(str(error))}")
                    print(f"    rejected: {redact(str(error))[:90]}")
                else:
                    raise AssertionError("wrong sudo password unexpectedly succeeded after "
                                         "the timestamp reset")

            def case_password_recovered():
                req("ssh/settings/set", {"sessionId": session_id, "sudoPassword": setup.password})
                result = req("ssh/exec", {"sessionId": session_id, "command": "echo keep-4",
                                          "sudo": True}, timeout=120)
                if result.get("exitCode") != 0 or "keep-4" not in result.get("output", ""):
                    raise AssertionError(f"sudo exec wrong after recovery: {json.dumps(result)[:160]}")

            report.run("ssh/exec quick sudo executes with the configured password", "ssh/exec",
                       case_sudo_password_exec)
            report.run("ssh/sessions/list registers sudoKeepalive after a sudo exec",
                       "ssh/sessions/list", case_sudo_keepalive_registered,
                       needs="ssh/exec quick sudo executes with the configured password")
            report.run("cached sudo timestamp answers a sudo exec without a password prompt",
                       "ssh/exec", case_cached_timestamp_skips_prompt,
                       needs="ssh/exec quick sudo executes with the configured password")
            report.run("wrong sudo password fails after the timestamp reset", "ssh/exec",
                       case_wrong_password_fails_after_reset,
                       needs="cached sudo timestamp answers a sudo exec without a password prompt")
            report.run("restored sudo password executes again", "ssh/exec",
                       case_password_recovered,
                       needs="wrong sudo password fails after the timestamp reset")

            # -- phase 2: OTP anti-replay -------------------------------------

            secret_a = new_totp_secret()
            secret_b = new_totp_secret()
            secret_c = new_totp_secret()

            def case_settings_mask_secrets():
                req("ssh/settings/set", {"sessionId": session_id,
                                         "totpSecret": f"{secret_a};{secret_b}"})
                settings = req("ssh/settings/get", {"sessionId": session_id}, timeout=30)
                if settings.get("totpConfigured") is not True:
                    raise AssertionError(f"totpConfigured not reported: {json.dumps(settings)[:160]}")
                if settings.get("sudoPasswordSet") is not True:
                    raise AssertionError("sudoPasswordSet not reported")
                blob = json.dumps(settings)
                for secret in (secret_a, secret_b):
                    if secret in blob:
                        raise AssertionError("ssh/settings/get echoed TOTP secret material")
                print(f"    totpConfigured={settings.get('totpConfigured')} "
                      f"flowMode={settings.get('authFlowMode')} (secrets not echoed)")

            def case_settings_reveal_secrets():
                # 默认 get 只报布尔位；revealSecrets: true 回显本连接原值
                # （多密钥原文，设置弹窗预填用）。
                configured = f"{secret_a};{secret_b}"
                revealed = req("ssh/settings/get",
                               {"sessionId": session_id, "revealSecrets": True},
                               timeout=30)
                if revealed.get("totpSecret") != configured:
                    raise AssertionError(
                        f"reveal mismatch: {json.dumps(revealed)[:160]}")
                if "sudoPassword" not in revealed:
                    raise AssertionError("reveal response missing sudoPassword key")
                print("    revealSecrets echoed the configured multi-secret verbatim")

            def read_log_new_rows(before: int) -> list[tuple[str, str, str]]:
                rows = setup.read_submission_log()
                return rows[before:]

            def case_current_window_otp_accepted():
                window = ensure_window_margin(14)
                expected = totp_window(secret_a, window)
                setup.set_otp_mode(True, expected)
                before = len(setup.read_submission_log())
                result = req("ssh/exec", {"sessionId": session_id, "command": "echo otp-ok",
                                          "sudo": True}, timeout=120)
                if result.get("exitCode") != 0 or "otp-ok" not in result.get("output", ""):
                    raise AssertionError(f"OTP sudo exec failed: {json.dumps(result)[:200]}")
                rows = read_log_new_rows(before)
                accepted = [code for _, code, verdict in rows if verdict == "ACCEPT"]
                if accepted != [expected]:
                    raise AssertionError(f"submission log mismatch: got "
                                         f"{[mask(c) for c in accepted]}, want "
                                         f"{mask(expected)}")
                print(f"    accepted current-window code {mask(expected)} (window {window})")

            def case_same_window_rotates_to_second_secret():
                before = len(setup.read_submission_log())
                try:
                    req("ssh/exec", {"sessionId": session_id, "command": "echo replay",
                                     "sudo": True}, timeout=120)
                except SidecarError as error:
                    if "authentication" not in str(error).lower() \
                            and "incorrect password" not in str(error).lower():
                        raise AssertionError(f"unexpected failure mode: {redact(str(error))}")
                    print(f"    rejected: {redact(str(error))[:90]}")
                else:
                    raise AssertionError("same-window replay unexpectedly succeeded")
                rows = read_log_new_rows(before)
                submitted = [code for _, code, _ in rows if code]
                now_window = int(time.time() // TOTP_PERIOD)
                a_windows = {totp_window(secret_a, w)
                             for w in (now_window - 1, now_window, now_window + 1)}
                b_windows = {totp_window(secret_b, w)
                             for w in (now_window - 1, now_window, now_window + 1)}
                if not submitted:
                    raise AssertionError(
                        "no OTP submission observed for the second attempt; "
                        f"full submission log: {setup.read_submission_log()}")
                if any(code in a_windows for code in submitted):
                    raise AssertionError("the first window's code was replayed")
                if not any(code in b_windows for code in submitted):
                    raise AssertionError(f"rotation did not submit the second secret's code "
                                         f"(got {[mask(c) for c in submitted]})")
                print(f"    rotated to the second secret: submitted {mask(submitted[-1])}, "
                      f"server rejected it (anti-replay)")

            def case_third_attempt_hard_skips():
                before = len(setup.read_submission_log())
                try:
                    req("ssh/exec", {"sessionId": session_id, "command": "echo third",
                                     "sudo": True}, timeout=120)
                except SidecarError as error:
                    if "incorrect password" not in str(error).lower() \
                            and "authentication" not in str(error).lower():
                        raise AssertionError(f"unexpected failure mode: {redact(str(error))}")
                    print(f"    rejected: {redact(str(error))[:90]}")
                else:
                    raise AssertionError("third same-window attempt unexpectedly succeeded")
                rows = read_log_new_rows(before)
                if any(code for _, code, _ in rows):
                    raise AssertionError(f"a code was still submitted: "
                                         f"{[mask(c) for _, c, _ in rows]}")
                print("    no new OTP submission (replay-window hard skip)")

            def case_wrong_otp_secret_fails():
                window = ensure_window_margin(10)
                expected = totp_window(secret_a, window)
                setup.set_otp_mode(True, expected)
                req("ssh/settings/set", {"sessionId": session_id, "totpSecret": secret_c})
                before = len(setup.read_submission_log())
                try:
                    req("ssh/exec", {"sessionId": session_id, "command": "echo wrong-otp",
                                     "sudo": True}, timeout=120)
                except SidecarError as error:
                    if "incorrect password" not in str(error).lower() \
                            and "authentication" not in str(error).lower():
                        raise AssertionError(f"unexpected failure mode: {redact(str(error))}")
                    print(f"    rejected: {redact(str(error))[:90]}")
                else:
                    raise AssertionError("wrong OTP secret unexpectedly succeeded")
                rows = read_log_new_rows(before)
                submitted = [code for _, code, _ in rows if code]
                a_windows = {totp_window(secret_a, w)
                             for w in (window - 1, window, window + 1)}
                c_windows = {totp_window(secret_c, w)
                             for w in (window - 1, window, window + 1)}
                if not submitted:
                    raise AssertionError("wrong-secret attempt submitted nothing")
                if any(code in a_windows for code in submitted):
                    raise AssertionError("submission matched the expected (valid) code")
                if not any(code in c_windows for code in submitted):
                    raise AssertionError(f"submission was not derived from secret C: "
                                         f"{[mask(c) for c in submitted]}")
                print(f"    wrong secret submitted {mask(submitted[-1])} and failed")

            report.run("ssh/settings/set registers TOTP secrets without echoing them",
                       "ssh/settings/set", case_settings_mask_secrets)
            report.run("ssh/settings/get revealSecrets echoes the stored value",
                       "ssh/settings/get", case_settings_reveal_secrets,
                       needs="ssh/settings/set registers TOTP secrets without echoing them")
            report.run("current-window OTP is auto-answered and accepted end to end",
                       "ssh/exec", case_current_window_otp_accepted,
                       needs="ssh/settings/set registers TOTP secrets without echoing them")
            report.run("same-window replay rotates to the second secret and is rejected",
                       "ssh/exec", case_same_window_rotates_to_second_secret,
                       needs="current-window OTP is auto-answered and accepted end to end")
            report.run("third same-window attempt hard-skips OTP submission", "ssh/exec",
                       case_third_attempt_hard_skips,
                       needs="same-window replay rotates to the second secret and is rejected")
            report.run("wrong OTP secret fails authentication", "ssh/exec",
                       case_wrong_otp_secret_fails,
                       needs="current-window OTP is auto-answered and accepted end to end")

    finally:
        step("cleanup / restore")
        setup.set_otp_mode(False)
        if client is not None:
            try:
                if session_id:
                    client.request("ssh/session/close", {"sessionId": session_id}, timeout=30)
            except Exception:
                pass
            try:
                client.request("connection/disconnect", {"connection": {"id": connection_id}},
                               timeout=30)
            except Exception:
                pass
            client.close()
        setup.restore()
        shutil.rmtree(data_dir, ignore_errors=True)
        for note in setup.notes:
            print(f"    WARNING: {note}")
        print("    container restored (sudoers, password, shim, OTP state)")

    elapsed = time.monotonic() - started
    print(f"\n==== sudo/otp smoke summary: {len(report.passed)} passed, "
          f"{len(report.skipped)} skipped, {len(report.failed)} failed ({elapsed:.1f}s) ====")
    if skip_all:
        print(f"  SKIP: all cases — {skip_all}")
    for title, reason in report.skipped:
        print(f"  SKIP: {title} — {reason}")
        for title, reason in report.failed:
            print(f"  FAIL: {title} — {reason}")
        if report.failed:
            # Sidecar 已随 close() 退出：此刻 drain stderr 才不会阻塞，
            # 排查编排侧 "otp auto-answer skipped" 之类的诊断行。
            stderr_tail = client.drain_stderr() if client is not None else ""
            diagnostics = [line for line in stderr_tail.splitlines()
                           if "otp" in line.lower() or "sudo" in line.lower()
                           or "trace" in line.lower()]
            if diagnostics:
                print("  sidecar stderr (filtered):")
                for line in diagnostics[-12:]:
                    print(f"    {line}")
            sys.exit(1)
    print("sudo/otp smoke: all green")


if __name__ == "__main__":
    main()
