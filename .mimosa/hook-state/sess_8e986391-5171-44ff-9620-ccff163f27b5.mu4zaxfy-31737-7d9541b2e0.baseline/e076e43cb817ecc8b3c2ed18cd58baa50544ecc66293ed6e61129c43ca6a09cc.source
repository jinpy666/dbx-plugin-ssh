#!/usr/bin/env bash
# Install (or upgrade) the newest dist/*.dbxp into a DBX plugin store using
# the official PluginPackageInstaller (checksum + compatibility verified),
# then restart DBX.
#
# Usage:
#   scripts/install.sh                    # install into the real DBX app store
#   scripts/install.sh --app-data <dir>   # target a custom DBX data directory
#   scripts/install.sh --reinstall        # dev only: drop the installed version first
#   scripts/install.sh --no-restart       # do not relaunch DBX afterwards
#   scripts/install.sh --keep-old         # keep older io.dbx.ssh versions for rollback
#
# Environment:
#   DBX_HOST_WORKTREE   host checkout used for the installer binary
#                       (optional; defaults to a Codex worktree or the
#                       sibling ../dbx checkout when omitted)
#   DBX_TEST_APP        DBX.app bundle to relaunch on macOS, or the dbx.exe
#                       path on Windows (default: probe the host worktree /
#                       uninstall registry, then fall back to `open -a DBX`)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

host_worktree_is_valid() {
  local candidate="$1"
  [ -d "$candidate" ] || return 1
  [ -f "$candidate/Cargo.toml" ] || return 1
  [ -f "$candidate/crates/dbx-core/Cargo.toml" ] || return 1
  git -C "$candidate" rev-parse --show-toplevel >/dev/null 2>&1
}

resolve_host_worktree() {
  local candidate
  local candidate_list=()
  local user_home="${HOME:-}"
  local codex_worktrees="$user_home/.codex/worktrees"
  local sibling_root

  # An explicit path is authoritative. Do not silently fall back when it is
  # set but invalid: that could install into an unintended DBX checkout.
  if [ -n "${DBX_HOST_WORKTREE:-}" ]; then
    if host_worktree_is_valid "$DBX_HOST_WORKTREE"; then
      printf '%s\n' "$DBX_HOST_WORKTREE"
      return 0
    fi
    echo "DBX_HOST_WORKTREE is not a valid DBX host worktree: $DBX_HOST_WORKTREE" >&2
    echo "Expected Cargo.toml and crates/dbx-core/Cargo.toml in a Git checkout." >&2
    return 1
  fi

  # Codex-managed host worktrees are preferred because they are isolated from
  # the plugin checkout and commonly already contain the installer binary.
  if [ -d "$codex_worktrees" ]; then
    for candidate in "$codex_worktrees"/*/dbx; do
      [ -e "$candidate" ] || continue
      host_worktree_is_valid "$candidate" && candidate_list+=("$candidate")
    done
  fi

  # Use the sibling DBX checkout for the local development layout.
  sibling_root="$(dirname "$REPO_ROOT")"
  for candidate in "$sibling_root/dbx"; do
    host_worktree_is_valid "$candidate" && candidate_list+=("$candidate")
  done

  [ "${#candidate_list[@]}" -gt 0 ] || {
    echo "DBX host worktree not found." >&2
    echo "Set DBX_HOST_WORKTREE explicitly, or place a host checkout under:" >&2
    echo "  $codex_worktrees/<worktree>/dbx" >&2
    echo "  $sibling_root/dbx" >&2
    return 1
  }

  printf '%s\n' "${candidate_list[0]}"
}

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
  *) IS_WINDOWS=0 ;;
esac

# Resolve DBX.exe from the uninstall registry on Windows (DisplayIcon points
# at the exe); returns a Windows-style path, empty when not found.
dbx_exe_from_registry() {
  powershell -NoProfile -Command 'Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*,HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue | Where-Object DisplayName -eq "DBX" | Select-Object -First 1 -ExpandProperty DisplayIcon' \
    2>/dev/null | tr -d '\r' | tr -d '"' | head -1
}

if [ "$IS_WINDOWS" = 1 ]; then
  APP_DATA="${DBX_APP_DATA:-${APPDATA:-$HOME/AppData/Roaming}/com.dbx.app}"
else
  APP_DATA="${DBX_APP_DATA:-$HOME/Library/Application Support/com.dbx.app}"
fi
REINSTALL=0
RESTART=1
KEEP_OLD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app-data) APP_DATA="$2"; shift 2 ;;
    --reinstall) REINSTALL=1; shift ;;
    --no-restart) RESTART=0; shift ;;
    --keep-old) KEEP_OLD=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

DBXP="$(ls -t dist/*.dbxp 2>/dev/null | head -1 || true)"
[ -n "$DBXP" ] || { echo "no .dbxp in dist/ — run scripts/build.sh first" >&2; exit 1; }
VERSION="$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")"

DBX_HOST_WORKTREE="$(resolve_host_worktree)"
export DBX_HOST_WORKTREE
echo "==> using DBX host worktree: $DBX_HOST_WORKTREE"
export PATH="$HOME/.cargo/bin:$PATH"

INSTALLER="$DBX_HOST_WORKTREE/target/release/examples/install_plugin"
[ "$IS_WINDOWS" = 1 ] && INSTALLER="$INSTALLER.exe"
if [ ! -x "$INSTALLER" ]; then
  echo "==> building PluginPackageInstaller example"
  (cd "$DBX_HOST_WORKTREE" && cargo build -p dbx-core --example install_plugin --release)
fi

DBX_EXE=""
if [ "$IS_WINDOWS" = 1 ]; then
  DBX_EXE="${DBX_TEST_APP:-}"
  [ -n "$DBX_EXE" ] && [ ! -f "$DBX_EXE" ] && DBX_EXE=""
  [ -z "$DBX_EXE" ] && DBX_EXE="$(dbx_exe_from_registry)"
  APP_VERSION=""
  if [ -n "$DBX_EXE" ]; then
    APP_VERSION="$(powershell -NoProfile -Command "(Get-Item '$DBX_EXE').VersionInfo.ProductVersion" \
      2>/dev/null | tr -d '\r' | head -1)"
  fi
  APP_VERSION="${APP_VERSION:-0.6.0}"
else
  APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
    /Applications/DBX.app/Contents/Info.plist 2>/dev/null || echo 0.6.0)"
fi

WAS_RUNNING=0
if [ "$IS_WINDOWS" = 1 ]; then
  if tasklist //FI "IMAGENAME eq dbx.exe" 2>/dev/null | grep -qi "dbx\.exe"; then
    WAS_RUNNING=1
  fi
  echo "==> stopping DBX"
  taskkill //F //IM dbx.exe >/dev/null 2>&1 || true
  sleep 2
else
  if pgrep -f "DBX.app/Contents/MacOS/dbx" >/dev/null 2>&1; then
    WAS_RUNNING=1
  fi
  echo "==> stopping DBX"
  osascript -e 'quit app id "com.dbx.app"' >/dev/null 2>&1 || true
  sleep 2
  pkill -f "DBX.app/Contents/MacOS/dbx" 2>/dev/null || true
  sleep 1
fi

PLUGIN_STORE="$APP_DATA/plugins"
if [ "$REINSTALL" = 1 ]; then
  VERSION_DIR="$PLUGIN_STORE/io.dbx.ssh/versions/$VERSION"
  if [ -d "$VERSION_DIR" ]; then
    echo "==> dev reinstall: removing installed v$VERSION"
    rm -rf "$VERSION_DIR"
    python3 - "$PLUGIN_STORE/io.dbx.ssh/activations" "$VERSION" <<'PY'
import json, pathlib, sys
store = pathlib.Path(sys.argv[1])
version = sys.argv[2]
if store.is_dir():
    for record in store.glob("*.json"):
        try:
            if json.load(open(record)).get("version") == version:
                record.unlink()
        except Exception:
            pass
PY
  fi
fi

echo "==> installing $(basename "$DBXP") (v$VERSION) into $PLUGIN_STORE"
"$INSTALLER" "$PLUGIN_STORE" "$DBXP" "$APP_VERSION"

if [ "$KEEP_OLD" = 0 ]; then
  echo "==> cleaning old io.dbx.ssh versions (keeping v$VERSION)"
  python3 - "$PLUGIN_STORE" "$VERSION" <<'PY'
import json
import pathlib
import shutil
import sys

plugin_store = pathlib.Path(sys.argv[1])
current_version = sys.argv[2]
versions_dir = plugin_store / "io.dbx.ssh" / "versions"
activations_dir = plugin_store / "io.dbx.ssh" / "activations"

removed_versions = []
if versions_dir.is_dir():
    for version_dir in sorted(versions_dir.iterdir()):
        if version_dir.name == current_version:
            continue
        if version_dir.is_dir() or version_dir.is_symlink():
            shutil.rmtree(version_dir)
            removed_versions.append(version_dir.name)

removed_activations = []
if activations_dir.is_dir():
    for record in sorted(activations_dir.glob("*.json")):
        try:
            record_version = json.loads(record.read_text()).get("version")
        except (OSError, ValueError, TypeError):
            continue
        if record_version != current_version:
            record.unlink()
            removed_activations.append(record.name)

print(f"  removed versions: {', '.join(removed_versions) or 'none'}")
print(f"  removed activations: {len(removed_activations)}")
PY
else
  echo "==> keeping old io.dbx.ssh versions (--keep-old)"
fi

if [ "$RESTART" = 1 ] && [ "$WAS_RUNNING" = 1 ]; then
  echo "==> restarting DBX"
  if [ "$IS_WINDOWS" = 1 ]; then
    if [ -n "$DBX_EXE" ]; then
      cmd //c start "" "$DBX_EXE"
    else
      echo "WARN: DBX.exe path unknown (set DBX_TEST_APP); start DBX manually" >&2
    fi
  elif [ -n "${DBX_TEST_APP:-}" ] && [ -d "$DBX_TEST_APP" ]; then
    open "$DBX_TEST_APP"
  elif [ -d "$DBX_HOST_WORKTREE/target/debug/bundle/macos/DBX.app" ]; then
    open "$DBX_HOST_WORKTREE/target/debug/bundle/macos/DBX.app"
  else
    open -a DBX
  fi
fi
echo "installed v$VERSION"
