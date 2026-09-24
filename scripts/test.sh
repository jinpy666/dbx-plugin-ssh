#!/usr/bin/env bash
# Full verification suite for the SSH/SFTP plugin.
#
#   scripts/test.sh                # everything available on this machine
#   scripts/test.sh --skip-host    # skip the host-worktree install pipeline
#
# Steps: backend unit tests -> frontend typecheck/test/build -> sidecar
# release build -> .dbxp package -> MCP stdio smoke -> host install-pipeline
# integration test (PluginPackageInstaller + MCP bridge over a real sidecar).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

SKIP_HOST=0
[ "${1:-}" = "--skip-host" ] && SKIP_HOST=1

if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/v22*/bin 2>/dev/null | sort -V | tail -1 || true)"
  export PATH="$HOME/Library/pnpm:${NODE_BIN:+$NODE_BIN:}$PATH"
fi
export PATH="$HOME/.cargo/bin:$PATH"

# 用一次性数据目录跑全套：known_hosts / Quick Sudo 配置等状态不落用户真实
# 插件数据，主机密钥挑战类用例也可重复——否则测试容器一旦重建（host key
# 变更），remembered 记录会把连接按 MITM 防护直接拒掉。
export DBX_PLUGIN_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dbx-ssh-test-data.XXXXXX")"

echo "==> backend unit tests"
node scripts/connection-forms/verify.mjs
cargo test --manifest-path backend/Cargo.toml

echo "==> dead-code warning gate"
# 未接线的功能会先以 dead_code 警告形态暴露（案例：remembered 审批 /
# ssh_terminal_input 的安全函数写完却没接进路由）。零容忍：
# cargo build 出现任何 "never used" 警告即失败，避免新功能静默脱接。
if cargo build --manifest-path backend/Cargo.toml 2>&1 | grep -q "never used"; then
  echo "FAIL: dead-code warnings present (an unwired feature or leftover code?):"
  cargo build --manifest-path backend/Cargo.toml 2>&1 | grep -B1 "never used"
  exit 1
fi
echo "  no dead-code warnings"

echo "==> frontend typecheck + tests + build"
[ -d frontend/node_modules ] || pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend typecheck
pnpm --dir frontend test
pnpm --dir frontend build

echo "==> sidecar release build"
cargo build --release --manifest-path backend/Cargo.toml

echo "==> package .dbxp"
# 与 build.sh 一致：把 CLI 内部 cargo build 重定向到热的 backend/target。
# 不重定向时 CLI 用一次性 dist/.build-rust-<triple> 暂存目录——整树冷编译，
# 且会被并发/下一次打包的清理踩掉（表现为写 .fingerprint 时 ENOENT）。
export CARGO_TARGET_DIR="$ROOT/backend/target"
# CLI 打包的内部 cargo build 会把 Rust SDK patch 覆盖到 DBX_PLUGIN_SDK_ROOT；
# 未设置时 npm 包装器注入 CLI 自带 sdk-root，vendored SDK（shared/sdk/）的本地
# 修复进不了产物——用垫片把 SDK 根指回 vendored 副本，打完做字节级反例断言。
if command -v dbx-plugin >/dev/null 2>&1; then
  export DBX_PLUGIN_SDK_ROOT="$(bash scripts/sdk_root_shim.sh)"
  NO_COLOR=1 dbx-plugin package .
  python3 scripts/verify_packaged_sdk.py
else
  echo "SKIP: dbx-plugin CLI unavailable; install @dbx-app/plugin-cli to run package verification"
fi

echo "==> MCP stdio smoke"
python3 scripts/smoke_mcp.py --binary backend/target/release/dbx-plugin-ssh

# 本地终端冒烟：驱动本机登录 shell（spawn/注入标记/回显/关闭），不需要
# SSH 容器；二进制缺失时脚本自 SKIP。放 docker 小节之外，任何机器都跑。
echo "==> local terminal smoke"
python3 scripts/smoke_local_terminal.py --binary backend/target/release/dbx-plugin-ssh

# Live-container smokes + perf baseline: each script SKIPs its cases when the
# test container is unavailable; the whole section is skipped when docker or
# the dbx-ssh-test container is absent so the suite stays green everywhere.
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'dbx-ssh-test'; then
  export DBX_PLUGIN_SIDECAR="$ROOT/backend/target/release/dbx-plugin-ssh"
  echo "==> live smoke: smoke_test.py"
  python3 scripts/smoke_test.py
  echo "==> live smoke: smoke_fs_test.py"
  python3 scripts/smoke_fs_test.py
  echo "==> live smoke: smoke_batch3_test.py"
  python3 scripts/smoke_batch3_test.py
  echo "==> live smoke: smoke_sudo_otp_test.py"
  python3 scripts/smoke_sudo_otp_test.py
  echo "==> live smoke: smoke_trigger_test.py"
  python3 scripts/smoke_trigger_test.py
  echo "==> perf baseline (P-SSH §3; ±20% thresholds documented in TEST_MATRIX)"
  python3 scripts/perf_baseline_test.py
else
  echo "SKIP: live smokes + perf baseline (docker or dbx-ssh-test container unavailable)"
fi

# Mock UI walkthrough (COLLECT-FINAL suggestion 1): headless-Chrome anchor
# assertions + screenshot. Self-gating — SKIPs (exit 0) without playwright-core
# (/tmp/dbx-ui-mock) or system Chrome; a real failure fails the suite.
echo "==> mock UI walkthrough"
node scripts/smoke_ui_mock.mjs

if [ "$SKIP_HOST" = 0 ]; then
  HOST="${DBX_HOST_WORKTREE:-}"
  if [ -n "$HOST" ] && [ -d "$HOST" ]; then
    echo "==> host install-pipeline integration (installer + MCP bridge)"
    PACKAGE="$ROOT/$(ls -t dist/*.dbxp | head -1)"
    # The bridge test tracks in-progress MCP plugin-tools work; if it does not
    # compile yet, skip it instead of failing the whole suite. Once it
    # compiles it must pass.
    if (cd "$HOST" && cargo test -p dbx-mcp --test plugin_tools_bridge --no-run >/dev/null 2>&1); then
      (cd "$HOST" && DBX_SSH_SFTP_PACKAGE="$PACKAGE" cargo test -p dbx-mcp --test plugin_tools_bridge)
    else
      echo "SKIP: plugin_tools_bridge does not compile (MCP plugin-tools bridge WIP not integrated)"
    fi
  else
    echo "==> host install-pipeline integration skipped (standalone checkout; set DBX_HOST_WORKTREE to opt in)"
  fi
else
  echo "==> host install-pipeline integration skipped (--skip-host)"
fi

echo
echo "all green"
