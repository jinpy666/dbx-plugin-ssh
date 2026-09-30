#!/usr/bin/env bash
# dbx-plugin CLI 打包用的 DBX_PLUGIN_SDK_ROOT 垫片。
#
# dbx-plugin 的 npm 包装器在 DBX_PLUGIN_SDK_ROOT 未设置时，会把 CLI 自带的
# sdk-root 注入给 native 二进制；后者按 <SDK_ROOT>/plugins/sdk/rust/dbx-plugin-sdk
# 覆盖 Cargo 的 [patch.crates-io]，仓库 vendored 的 shared/sdk（含本地修复）
# 因此永远进不了 CLI 打出的 .dbxp（案例：0.4.79 的终端输入顺序修复）。
#
# 本脚本构造一个 CLI 期望布局的 SDK 根并打印其路径：Rust SDK 指向本仓库
# vendored 副本；Go SDK 尽量复用 CLI 自带的（找不到则落一个最小 go.mod
# 占位——Rust 工程不会用到）。垫片目录名不得含 "sdk-root" 字样，它会被
# 嵌进二进制的 panic 路径，而 verify_packaged_sdk.py 以该字样做反例断言。
#
# 用法：export DBX_PLUGIN_SDK_ROOT="$(bash scripts/sdk_root_shim.sh)"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUST_SDK="$ROOT/shared/sdk/rust/dbx-plugin-sdk"
[ -f "$RUST_SDK/Cargo.toml" ] || { echo "vendored Rust SDK not found at $RUST_SDK" >&2; exit 1; }

shim="$(mktemp -d "${TMPDIR:-/tmp}/dbx-vendored-sdk.XXXXXX")"
mkdir -p "$shim/plugins/sdk/rust" "$shim/plugins/sdk/go"
ln -s "$RUST_SDK" "$shim/plugins/sdk/rust/dbx-plugin-sdk"

go_sdk="$(ls -d "$(npm root -g 2>/dev/null)/@dbx-app/plugin-cli/sdk-root/plugins/sdk/go/dbx-plugin-sdk" 2>/dev/null || true)"
if [ -n "$go_sdk" ] && [ -f "$go_sdk/go.mod" ]; then
  ln -s "$go_sdk" "$shim/plugins/sdk/go/dbx-plugin-sdk"
else
  mkdir -p "$shim/plugins/sdk/go/dbx-plugin-sdk"
  printf 'module dbx-plugin-sdk\n\ngo 1.21\n' > "$shim/plugins/sdk/go/dbx-plugin-sdk/go.mod"
fi

echo "$shim"
