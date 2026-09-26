#!/usr/bin/env bash
# Build the plugin frontend and package a .dbxp for the current platform.
# Requires: node + pnpm on PATH, cargo for the Rust sidecar.
# The dbx-plugin CLI bundles its own packaging SDK; the Rust sidecar SDK used
# by this repository is vendored under shared/sdk/.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v pnpm >/dev/null; then
  export PATH="$HOME/Library/pnpm:$HOME/.nvm/versions/node/v22.21.0/bin:$PATH"
fi
# Prepend only when cargo is not already resolvable: the release CI installs a
# cargo→cargo-zigbuild wrapper ahead of the rustup shim (Linux sidecars must
# link a low glibc baseline), and an unconditional prepend here would shadow
# the wrapper and silently revert Linux builds to the runner's native glibc.
if ! command -v cargo >/dev/null 2>&1; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

# Release CI builds the target-independent UI once per plugin and stages ui/
# here as an artifact; DBX_PREBUILT_UI=1 packages it as-is instead of rerunning
# the frontend three-step on every platform job.
if [ "${DBX_PREBUILT_UI:-0}" = "1" ]; then
  if [ ! -f ui/index.html ]; then
    echo "DBX_PREBUILT_UI=1 but ui/index.html is missing; stage the CI frontend artifact first" >&2
    exit 1
  fi
  echo "==> frontend: skipped (prebuilt ui/ staged by CI)"
else
  echo "==> frontend: install + typecheck + test + build"
  # Skip install when node_modules is fresh (lockfile unchanged since); saves
  # seconds on every warm build — same trade-off ldap already makes.
  if [ ! -d frontend/node_modules ] || [ frontend/pnpm-lock.yaml -nt frontend/node_modules ]; then
    pnpm --dir frontend install --frozen-lockfile
  fi
  pnpm --dir frontend typecheck
  pnpm --dir frontend test
  pnpm --dir frontend build
fi

# dbx-plugin package runs its own `cargo build` for the Rust backend; without
# CARGO_TARGET_DIR it builds into a throwaway dist/.build-rust-<triple> staging
# dir (wiped afterwards) = full dep-tree rebuild on every release. Redirect it
# to the warm backend/target — verified the CLI reuses and keeps it. Do NOT pin
# RUSTUP_TOOLCHAIN here (docker builds via rust:1 + cargo-zigbuild lack 1.97.1);
# the release pipeline pins it itself.
export CARGO_TARGET_DIR="$PWD/backend/target"

echo "==> package .dbxp"
# CLI 打包的内部 cargo build 会把 Rust SDK patch 覆盖到 DBX_PLUGIN_SDK_ROOT；
# 未设置时 npm 包装器注入 CLI 自带 sdk-root，vendored SDK（shared/sdk/）的本地
# 修复进不了产物——用垫片把 SDK 根指回 vendored 副本，打完做字节级反例断言。
export DBX_PLUGIN_SDK_ROOT="$(bash scripts/sdk_root_shim.sh)"
if ! command -v dbx-plugin >/dev/null 2>&1; then
  echo "dbx-plugin CLI not found; install @dbx-app/plugin-cli or set PATH before packaging" >&2
  exit 1
fi
NO_COLOR=1 dbx-plugin package .
python3 scripts/verify_packaged_sdk.py

echo
echo "Artifacts:"
ls -la dist/*.dbxp dist/*.artifact.json
