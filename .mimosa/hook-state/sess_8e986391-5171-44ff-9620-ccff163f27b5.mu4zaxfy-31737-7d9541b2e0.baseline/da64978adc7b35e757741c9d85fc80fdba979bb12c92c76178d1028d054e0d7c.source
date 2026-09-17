#!/usr/bin/env python3
"""Instance-level e2e for the DBX app bridge path of teaching mode.

Requires the test host DBX.app (plugin-framework debug bundle) with the e2e
app-data: the io.dbx.ssh plugin installed and a saved connection (default id
"vagrant"). Scenarios:

  T1  stdio runInTerminal + saved connectionId → forwarded into the app's
      own sidecar, workbench tab auto-opens, command runs visibly, marker
      returns to the caller.
  T2  stdio runInTerminal with inline credentials (no connectionId) →
      guidance error naming the saved-connection requirement.
  T3  bridge unreachable (empty DBX_APP_DATA_DIR + no-op launch cmd) →
      error names the DBX app bridge and does not hang.
  T4  auto-launch: with the app stopped and DBX_APP_LAUNCH_CMD pointing at
      a launcher script, a forwarded call relaunches the app and completes.
  T5  shell-state reuse across forwarded calls (export → echo $VAR), i.e.
      successive forwards reuse the same app-side workbench PTY.

Usage:
  python3 scripts/e2e_agent_app_bridge.py \
      [--app-data /path/to/app-data] [--bundle /path/to/DBX.app] \
      [--connection-id vagrant] [--binary <sidecar>] [--skip-autolaunch]
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from sidecar_client import McpStdioClient  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
BINARY_DEFAULT = str(REPO_ROOT / "backend" / "target/release/dbx-plugin-ssh")
APP_DATA_DEFAULT = str(REPO_ROOT / "work" / "app-data")
BUNDLE_DEFAULT = os.environ.get("DBX_TEST_APP", "")

results: list[tuple[str, bool, str]] = []


def report(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS" if ok else "FAIL") + f"  {name}" + (f"  -- {detail}" if detail else ""))


def app_running() -> int:
    probe = subprocess.run(["pgrep", "-f", "MacOS/dbx"],
                           capture_output=True, text=True, check=False)
    return int(probe.stdout.split()[0]) if probe.stdout.strip() else 0


def wait_for_port_file(app_data: str, wait: float) -> bool:
    port_file = pathlib.Path(app_data) / "mcp-bridge-port"
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if port_file.exists():
            return True
        time.sleep(0.5)
    return False


def write_launcher(bundle: str, app_data: str) -> str:
    """Writes the DBX_APP_LAUNCH_CMD target: a script that starts the
    test-host bundle against the e2e app-data in the background."""
    handle, path = tempfile.mkstemp(prefix="dbx-e2e-launch-", suffix=".sh")
    binary = os.path.join(bundle, "Contents/MacOS/dbx")
    log_path = path + ".log"
    with os.fdopen(handle, "w") as script:
        script.write("#!/bin/sh\n")
        script.write(f'DBX_DATA_DIR="{app_data}" nohup "{binary}" '
                     f'>>"{log_path}" 2>&1 &\n')
    os.chmod(path, 0o755)
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-data", default=APP_DATA_DEFAULT)
    parser.add_argument("--bundle", default=BUNDLE_DEFAULT)
    parser.add_argument("--connection-id", default="vagrant")
    parser.add_argument("--binary", default=BINARY_DEFAULT)
    parser.add_argument("--skip-autolaunch", action="store_true")
    args = parser.parse_args()

    if not shutil.which("pgrep"):
        print("pgrep unavailable; this suite is macOS-only", file=sys.stderr)
        return 2

    # ---- T1 visible execution through the auto-opened workbench -----------
    client = McpStdioClient(args.binary, {"DBX_APP_DATA_DIR": args.app_data})
    try:
        client.initialize()
        marker = f"appbridge-visible-{int(time.time())}"
        started = time.monotonic()
        result = client.call_tool("ssh_exec", {
            "connectionId": args.connection_id,
            "command": f"echo {marker} && hostname",
            "runInTerminal": True,
        })
        elapsed = time.monotonic() - started
        body = json.dumps(result)
        ok = (not result.get("isError")) and marker in body and '"mode": "terminal"' in body
        # The MCP envelope JSON-escapes its inner payload; substring checks on
        # the serialized body would miss escaped quotes, so judge from the
        # parsed tool result.
        try:
            inner = json.loads(result["content"][0]["text"])
            ok = (not result.get("isError")) and marker in str(inner.get("output", "")) \
                and inner.get("mode") == "terminal"
        except Exception:  # noqa: BLE001 — malformed envelope stays a FAIL
            ok = False
        report("T1 stdio转发→自动开工作台→可见执行", ok,
               f"{elapsed:.1f}s body={body[:260]}")
    except Exception as error:  # noqa: BLE001 — report and continue
        report("T1 stdio转发→自动开工作台→可见执行", False, str(error)[:200])

    # ---- T2 inline credentials are rejected with guidance ------------------
    try:
        client.call_tool("ssh_exec", {"host": "203.0.113.1", "username": "u",
                                      "command": "true", "runInTerminal": True})
        report("T2 内联凭据+runInTerminal 被引导拒绝", False, "unexpected success")
    except Exception as error:
        ok = "saved DBX connection" in str(error)
        report("T2 内联凭据+runInTerminal 被引导拒绝", ok, str(error)[:120])
    client.close()

    # ---- T3 bridge unreachable fails fast and clearly ----------------------
    lonely_dir = pathlib.Path(tempfile.mkdtemp(prefix="dbx-e2e-no-bridge-"))
    client = McpStdioClient(args.binary, {"DBX_APP_DATA_DIR": str(lonely_dir),
                                          "DBX_APP_LAUNCH_CMD": ":"})
    unreachable_started = time.monotonic()
    try:
        client.initialize()
        client.call_tool("ssh_exec", {"connectionId": args.connection_id,
                                      "command": "true",
                                      "runInTerminal": True}, timeout=60)
        report("T3 桥不可达快速明确报错", False, "unexpected success")
    except Exception as error:
        elapsed = time.monotonic() - unreachable_started
        ok = elapsed < 45 and "DBX app bridge" in str(error)
        report("T3 桥不可达快速明确报错", ok, f"{elapsed:.0f}s {str(error)[:100]}")
    finally:
        client.close()
        shutil.rmtree(lonely_dir, ignore_errors=True)

    # ---- T4 auto-launch from a stopped app ---------------------------------
    if not args.skip_autolaunch:
        if app_running():
            subprocess.run(["pkill", "-f", "MacOS/dbx"], check=False)
            time.sleep(2)
        launcher = write_launcher(args.bundle, args.app_data)
        client = McpStdioClient(args.binary, {"DBX_APP_DATA_DIR": args.app_data,
                                              "DBX_APP_LAUNCH_CMD": launcher})
        autolaunch_started = time.monotonic()
        try:
            client.initialize()
            marker = f"appbridge-autolaunch-{int(time.time())}"
            result = client.call_tool("ssh_exec", {
                "connectionId": args.connection_id,
                "command": f"echo {marker}",
                "runInTerminal": True,
            }, timeout=180)
            elapsed = time.monotonic() - autolaunch_started
            body = json.dumps(result)
            ok = (not result.get("isError")) and marker in body and app_running() > 0
            report("T4 app 未运行→自动唤起→执行成功", ok, f"{elapsed:.1f}s")
        except Exception as error:  # noqa: BLE001
            report("T4 app 未运行→自动唤起→执行成功", False, str(error)[:200])
        finally:
            client.close()
            if not wait_for_port_file(args.app_data, 10):
                print("warn: bridge port file missing after auto-launch")
            pathlib.Path(launcher).unlink(missing_ok=True)

    # ---- T5 shell-state reuse across forwarded calls ------------------------
    client = McpStdioClient(args.binary, {"DBX_APP_DATA_DIR": args.app_data})
    try:
        client.initialize()
        token = f"reuse-{int(time.time())}"
        client.call_tool("ssh_exec", {"connectionId": args.connection_id,
                                      "command": f"export APPBRIDGE_E2E={token}",
                                      "runInTerminal": True})
        result = client.call_tool("ssh_exec", {"connectionId": args.connection_id,
                                               "command": "echo $APPRIDGE_E2E",
                                               "runInTerminal": True})
        try:
            inner = json.loads(result["content"][0]["text"])
        except Exception:  # noqa: BLE001
            inner = {}
        report("T5 转发调用复用同一 app 侧 shell", token in str(inner.get("output", "")),
               json.dumps(inner)[:160])
    except Exception as error:  # noqa: BLE001
        report("T5 转发调用复用同一 app 侧 shell", False, str(error)[:200])
    finally:
        client.close()

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed"
          + (f"; FAILED: {failed}" if failed else " — app bridge e2e all green"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
