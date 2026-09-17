#!/usr/bin/env bash
# Package the plugin, then run the acceptance smokes against the binary
# packed INSIDE the .dbxp (SKILL.md "双冒烟验收" semantics, scripted).
#
# Closes the replacement window O5: `dbx-plugin package` rebuilds and
# overwrites backend/target/release/<binary>, so smokes run against the
# target dir may not exercise the bytes that were actually shipped. Here the
# binary is extracted from the package and used via DBX_PLUGIN_SIDECAR.
#
# Usage:
#   scripts/package_and_verify.sh              # build + package + verify
#   scripts/package_and_verify.sh --no-build   # reuse the existing dist/*.dbxp
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

if [ "${1:-}" != "--no-build" ]; then
  echo "==> cargo build --release"
  cargo build --release --manifest-path backend/Cargo.toml
  echo "==> dbx-plugin package ."
  unset DBX_PLUGIN_SDK_ROOT
  NO_COLOR=1 dbx-plugin package .
fi

PKG="$ROOT/$(ls -t dist/*.dbxp | head -1)"
echo "==> verifying package: $PKG"

VERIFY_DIR="$(mktemp -d /tmp/dbx-pkg-verify.XXXXXX)"
trap 'rm -rf "$VERIFY_DIR"' EXIT
unzip -q "$PKG" -d "$VERIFY_DIR"
BINARY="$(find "$VERIFY_DIR/bin" -type f -name dbx-plugin-ssh -perm -111 -print -quit)"
[ -n "$BINARY" ] || { echo "FAIL: packaged dbx-plugin-ssh binary missing under $VERIFY_DIR/bin"; exit 1; }
echo "packaged binary sha256: $(shasum -a 256 "$BINARY" | awk '{print $1}')"

export DBX_PLUGIN_SIDECAR="$BINARY"
echo "==> smoke_test.py (against packaged binary)"
python3 scripts/smoke_test.py
echo "==> smoke_fs_test.py (against packaged binary)"
python3 scripts/smoke_fs_test.py
echo "==> smoke_batch3_test.py (against packaged binary)"
python3 scripts/smoke_batch3_test.py
echo "package verification green"
