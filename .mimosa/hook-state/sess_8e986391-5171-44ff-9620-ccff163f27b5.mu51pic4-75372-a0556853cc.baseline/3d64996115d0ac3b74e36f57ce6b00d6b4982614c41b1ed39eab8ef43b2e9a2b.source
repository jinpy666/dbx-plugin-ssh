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
export PATH="$HOME/.cargo/bin:$PATH"

echo "==> frontend: install + typecheck + test + build"
# Skip install when node_modules is fresh (lockfile unchanged since); saves
# seconds on every warm build — same trade-off ldap already makes.
if [ ! -d frontend/node_modules ] || [ frontend/pnpm-lock.yaml -nt frontend/node_modules ]; then
  pnpm --dir frontend install --frozen-lockfile
fi
pnpm --dir frontend typecheck
pnpm --dir frontend test
pnpm --dir frontend build

# dbx-plugin package runs its own `cargo build` for the Rust backend; without
# CARGO_TARGET_DIR it builds into a throwaway dist/.build-rust-<triple> staging
# dir (wiped afterwards) = full dep-tree rebuild on every release. Redirect it
# to the warm backend/target — verified the CLI reuses and keeps it. Do NOT pin
# RUSTUP_TOOLCHAIN here (docker builds via rust:1 + cargo-zigbuild lack 1.97.1);
# the release pipeline pins it itself.
export CARGO_TARGET_DIR="$PWD/backend/target"

echo "==> package .dbxp"
unset DBX_PLUGIN_SDK_ROOT
if ! command -v dbx-plugin >/dev/null 2>&1; then
  echo "dbx-plugin CLI not found; install @dbx-app/plugin-cli or set PATH before packaging" >&2
  exit 1
fi
NO_COLOR=1 dbx-plugin package .

echo
echo "Artifacts:"
ls -la dist/*.dbxp dist/*.artifact.json
