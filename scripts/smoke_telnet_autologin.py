#!/usr/bin/env python3
"""Smoke test for the Telnet declarative auto-login (nyaterm-parity P0-1).

Validates the telnet/start contract WITHOUT any network dependency:

  1. rule form regression: invalid rules JSON still fails with the shared
     triggers error (parse path unchanged),
  2. declarative + rules together are rejected as mutually exclusive,
  3. invalid declarative regexes fail the start with readable field-named
     errors (successRegex / usernamePromptRegex / failureRegex),
  4. a declarative spec without credentials is rejected,
  5. maxRetries above the 0..=10 budget is rejected,
  6. a VALID declarative spec passes validation and returns a sessionId
     (the background dial to an unreachable port then errors on its own),
     and telnet/close tears the session down.

Every case exercises only start-time validation, so no Telnet server and no
SSH test container are needed. If telnet/start is not registered in the
sidecar binary under test, the cases SKIP instead of FAIL (same convention
as smoke_fs_test.py).

Usage:
    python3 scripts/smoke_telnet_autologin.py
    DBX_PLUGIN_SIDECAR=/path/to/dbx-plugin-ssh python3 scripts/smoke_telnet_autologin.py
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError


def step(name: str):
    print(f"\n==> {name}")


def missing_method(error: Exception) -> str | None:
    """Return the unregistered method name if the error means 'Method not found'."""
    text = str(error)
    if "Method not found" not in text and "-32601" not in text:
        return None
    match = re.search(r"Method not found:\s*([\w./-]+)", text)
    return match.group(1) if match else ""


class Report:
    """Per-case PASS/SKIP/FAIL bookkeeping (smoke_test reporting style)."""

    def __init__(self):
        self.passed: list[str] = []
        self.skipped: list[tuple[str, str]] = []
        self.failed: list[tuple[str, str]] = []

    def run(self, title: str, method: str, case):
        step(title)
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
        except Exception as error:  # noqa: BLE001 — report and continue
            print(f"FAIL: {error}")
            self.failed.append((title, str(error)))
        else:
            print("    PASS")
            self.passed.append(title)

    def finish(self, started: float) -> None:
        print(
            f"\n== smoke_telnet_autologin: {len(self.passed)} passed, "
            f"{len(self.skipped)} skipped, {len(self.failed)} failed "
            f"in {time.monotonic() - started:.1f}s"
        )
        if self.failed:
            for title, reason in self.failed:
                print(f"FAIL: {title}: {reason}", file=sys.stderr)
            sys.exit(1)


class SkipSignal(Exception):
    """Raised by a case to skip itself (method not registered)."""


def expect_start_error(client: SidecarClient, auto_login: dict, needle: str) -> None:
    """telnet/start must fail with a readable error containing `needle`."""
    try:
        client.request(
            "telnet/start",
            {
                "workbenchId": "smoke-telnet-al",
                "host": "127.0.0.1",
                "port": 2323,
                "autoLogin": auto_login,
            },
        )
    except SidecarError as error:
        if missing_method(error) is not None:
            raise SkipSignal("telnet/start not registered") from error
        text = str(error)
        if needle not in text:
            raise AssertionError(f"error '{text}' does not mention '{needle}'") from error
        if "s3cret" in text.lower():
            raise AssertionError(f"error leaks credential material: '{text}'") from error
        return
    raise AssertionError(f"telnet/start unexpectedly succeeded for {json.dumps(auto_login)[:120]}")


def main() -> None:
    started = time.monotonic()
    client = SidecarClient.start(timeout=30)
    report = Report()
    try:
        step("plugin/initialize")
        info = client.initialize()
        print(json.dumps(info, ensure_ascii=False)[:120])

        def case_rule_form_invalid_json_still_rejected():
            # 回归：规则形态的非法 JSON 报错保持不变（共享 triggers 校验路径）。
            expect_start_error(
                client,
                {"rules": "{not json", "secrets": ["", ""]},
                "invalid JSON",
            )

        def case_rules_and_declarative_mutually_exclusive():
            expect_start_error(
                client,
                {
                "rules": '{"stages":[{"pattern":"a","sendText":"x"}]}',
                    "secrets": ["", ""],
                    "declarative": {
                        "username": "dev",
                        "password": "s3cret-pass",
                        "maxRetries": 1,
                    },
                },
                "mutually exclusive",
            )

        def case_invalid_success_regex_rejected():
            expect_start_error(
                client,
                {
                    "declarative": {
                        "username": "dev",
                        "password": "s3cret-pass",
                        "successRegex": "(unclosed",
                        "maxRetries": 1,
                    }
                },
                "autoLogin.successRegex",
            )

        def case_invalid_username_prompt_regex_rejected():
            expect_start_error(
                client,
                {
                    "declarative": {
                        "username": "dev",
                        "usernamePromptRegex": "[bad",
                        "maxRetries": 1,
                    }
                },
                "autoLogin.usernamePromptRegex",
            )

        def case_invalid_failure_regex_rejected():
            expect_start_error(
                client,
                {
                    "declarative": {
                        "username": "dev",
                        "failureRegex": "*wrong",
                        "maxRetries": 1,
                    }
                },
                "autoLogin.failureRegex",
            )

        def case_missing_credentials_rejected():
            expect_start_error(
                client,
                {"declarative": {"username": "", "password": "", "maxRetries": 1}},
                "username or a password",
            )

        def case_retry_budget_cap_rejected():
            expect_start_error(
                client,
                {
                    "declarative": {
                        "username": "dev",
                        "password": "s3cret-pass",
                        "maxRetries": 11,
                    }
                },
                "autoLogin.maxRetries",
            )

        def case_valid_declarative_starts_and_closes():
            result = client.request(
                "telnet/start",
                {
                    "workbenchId": "smoke-telnet-al",
                    "host": "127.0.0.1",
                    # 不可达端口：start 仍应成功（后台拨号自行报错）。
                    "port": 1,
                    "autoLogin": {
                        "declarative": {
                            "username": "dev",
                            "password": "s3cret-pass",
                            "maxRetries": 2,
                        }
                    },
                },
            )
            session_id = result.get("sessionId")
            if not session_id:
                raise AssertionError(f"no sessionId in start result: {result}")
            print(f"    session {session_id} started")
            client.request("telnet/close", {"sessionId": session_id})

        report.run(
            "rule form: invalid JSON still rejected",
            "telnet/start",
            case_rule_form_invalid_json_still_rejected,
        )
        report.run(
            "declarative + rules are mutually exclusive",
            "telnet/start",
            case_rules_and_declarative_mutually_exclusive,
        )
        report.run(
            "declarative: invalid successRegex rejected",
            "telnet/start",
            case_invalid_success_regex_rejected,
        )
        report.run(
            "declarative: invalid usernamePromptRegex rejected",
            "telnet/start",
            case_invalid_username_prompt_regex_rejected,
        )
        report.run(
            "declarative: invalid failureRegex rejected",
            "telnet/start",
            case_invalid_failure_regex_rejected,
        )
        report.run(
            "declarative: missing credentials rejected",
            "telnet/start",
            case_missing_credentials_rejected,
        )
        report.run(
            "declarative: retry budget cap rejected",
            "telnet/start",
            case_retry_budget_cap_rejected,
        )
        report.run(
            "declarative: valid spec starts and closes",
            "telnet/start",
            case_valid_declarative_starts_and_closes,
        )
    finally:
        client.close()
    report.finish(started)


if __name__ == "__main__":
    main()
