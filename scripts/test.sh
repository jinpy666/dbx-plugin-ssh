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
  # Node 版本单一真源是仓库根 .nvmrc（CI setup-node node-version-file 同源）；
  # 精确版本缺失时回退 nvm 里最新的 v22。
  NODE_VER="$(head -n1 .nvmrc 2>/dev/null | tr -d 'vV\n ')"
  NODE_BIN="$(ls -d "$HOME/.nvm/versions/node/v${NODE_VER:-22.21.0}"/bin 2>/dev/null \
    || ls -d "$HOME"/.nvm/versions/node/v22*/bin 2>/dev/null | sort -V | tail -1 || true)"
  export PATH="$HOME/Library/pnpm:${NODE_BIN:+$NODE_BIN:}$PATH"
fi
export PATH="$HOME/.cargo/bin:$PATH"

# 用一次性数据目录跑全套：known_hosts / Quick Sudo 配置等状态不落用户真实
# 插件数据，主机密钥挑战类用例也可重复——否则测试容器一旦重建（host key
# 变更），remembered 记录会把连接按 MITM 防护直接拒掉。
export DBX_PLUGIN_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dbx-ssh-test-data.XXXXXX")"

echo "==> backend unit tests"
node scripts/connection-forms/verify.mjs
# 方法注册四路比对（backend 分派 ↔ mock 桩 ↔ 前端 invoke ↔ PROTOCOL 文档）：
# 分派臂/桩/调用点三方不一致是硬门禁，文档滞后 report-only。
node scripts/mock_host_registry_check.mjs
# 结构白名单与文件树一致性：只读文件树，秒级失败。放在编译前，避免白名单
# 过期要等整条链路（前端安装 + 后端编译）跑完才由 structure 测试报出来。
node scripts/refresh_structure_allowlist.mjs --check
# 单测密闭：宿主桥端口读 DBX_APP_DATA_DIR/mcp-bridge-port，未设时回落真实
# app 数据目录——开发机上 DBX 运行中会让 read_only 稳定性等用例读到真实连接
# （首次命中/二次抖动即漂移），甚至经 ensure_app_bridge 的 open -a 兜底拉起
# DBX。钉到一次性空目录（与 CI 无运行 DBX 同态），启动命令置 no-op。
# macOS 沙箱下 portable-pty 用例并发跑会互相干扰（pty 分配失败/超时抖动，
# 表现为随机失败）。因此仅 Darwin 默认串行；Linux 等平台保持并行，避免全量
# 跑无谓变慢。BACKEND_TEST_THREADS 在任何平台都优先（显式设置即覆盖默认）。
dbx_test_threads=""
if [ "$(uname -s)" = "Darwin" ]; then
  dbx_test_threads="${BACKEND_TEST_THREADS:-1}"
else
  dbx_test_threads="${BACKEND_TEST_THREADS:-}"
fi
if [ -n "$dbx_test_threads" ]; then
  DBX_APP_DATA_DIR="$DBX_PLUGIN_DATA_DIR" DBX_APP_LAUNCH_CMD="true" \
    cargo test --manifest-path backend/Cargo.toml \
    -- --test-threads="$dbx_test_threads"
else
  DBX_APP_DATA_DIR="$DBX_PLUGIN_DATA_DIR" DBX_APP_LAUNCH_CMD="true" \
    cargo test --manifest-path backend/Cargo.toml
fi

echo "==> dead-code warning gate"
# 未接线的功能会先以 dead_code 警告形态暴露（案例：remembered 审批 /
# ssh_terminal_input 的安全函数写完却没接进路由）。零容忍：
# cargo build 出现任何 dead_code 警告即失败，避免新功能静默脱接。
#
# 不要用 `cargo build ... | grep -q ...` 做判定：grep -q 命中即退出，
# cargo 继续写输出会收到 SIGPIPE（141），pipefail 下整条管道非零、if 被判
# 假，门禁静默放行。这里只构建一次并落盘，再对日志文件做匹配。
#
# 不能依赖热 target 的现成输出：cargo 对已是最新的单元只重放它缓存的诊断，
# 缓存缺失时（缓存恢复/换了构建入口）只剩 "Finished"，dead_code 警告不会
# 重新发出。也不用 `cargo clean -p`（删 1.6GiB 增量产物、整包重编）：把
# crate 根 mtime 推后 1s 强制 bin target 重编，让 rustc 必然重新发警告。
# 实测（热 target）强制重编约 2.5s，cargo clean -p + 重建约 19s。检查完
# 必须还原 mtime——Cargo 按路径源 mtime 判定新鲜度，不还原会让后续构建
# 误判源已更新而连带重编（实测还原后 cargo build 0.2s 直接 Finished）。
deadcode_log=""
main_mtime=""
cleanup_deadcode() {
  if [ -n "${main_mtime:-}" ] && [ -f "$main_mtime" ]; then
    # 每条退出路径（含构建失败/门禁命中）都还原 mtime。
    touch -r "$main_mtime" backend/src/main.rs 2>/dev/null || true
    rm -f "$main_mtime"
  fi
  if [ -n "${deadcode_log:-}" ]; then
    rm -f "$deadcode_log"
  fi
  return 0
}
trap cleanup_deadcode EXIT
deadcode_log="$(mktemp "${TMPDIR:-/tmp}/dbx-deadcode.XXXXXX")"
main_mtime="$(mktemp "${TMPDIR:-/tmp}/dbx-main-mtime.XXXXXX")"
touch -r backend/src/main.rs "$main_mtime"
sleep 1
touch backend/src/main.rs
if ! cargo build --manifest-path backend/Cargo.toml >"$deadcode_log" 2>&1; then
  cat "$deadcode_log" >&2
  echo "FAIL: cargo build failed (output above)" >&2
  exit 1
fi
# dead_code 的三种形态：未使用项 "never used"、未读字段 "is never read"、
# 未构造的结构体/枚举变体 "is never constructed"。模式抽成变量，判定与打印
# 共用，避免两处漂移。
DEADCODE_PATTERN='never used|never read|never constructed'
if grep -Eq "$DEADCODE_PATTERN" "$deadcode_log"; then
  echo "FAIL: dead-code warnings present (an unwired feature or leftover code?):" >&2
  grep -E -B1 "$DEADCODE_PATTERN" "$deadcode_log" >&2
  exit 1
fi
echo "  no dead-code warnings"

echo "==> frontend sandbox-confirm lint (SSH-H1 regression gate)"
# 宿主沙箱 iframe 无 allow-modals，window.confirm 恒返回 false——危险确认
# （覆盖/删除/强杀）必须走 lib/confirmDialog 应用内弹窗；出现即失败。
if grep -rn "window\.confirm(" frontend/src >/dev/null 2>&1; then
  echo "FAIL: window.confirm( found (sandbox iframe has no allow-modals, always false):" >&2
  grep -rn "window\.confirm(" frontend/src >&2
  exit 1
fi
echo "  no window.confirm calls"

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

# 协议矩阵真机层（telnet/serial Docker 真机覆盖，scripts/docker/protocol-matrix/）：
# 对真实 telnetd 跑 IAC/NAWS/自动登录，容器内 Linux sidecar 跑 socat 虚拟串口
# + X/Y/ZMODEM 回环（macOS 伪终端 ENOTTY 缺口的补位层）。Linux 冷构建较慢，
# 默认 opt-in（DBX_PROTOCOL_MATRIX=1），SKIP 时套件保持全绿。
if [ "${DBX_PROTOCOL_MATRIX:-0}" = "1" ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo "==> protocol matrix (docker telnet/serial real-device layer)"
    bash scripts/docker/protocol-matrix/run_matrix.sh
  else
    echo "SKIP: protocol matrix (docker unavailable)"
  fi
else
  echo "SKIP: protocol matrix (set DBX_PROTOCOL_MATRIX=1 to opt in)"
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
