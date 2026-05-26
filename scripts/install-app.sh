#!/bin/sh
# Installs MDE.app to /Applications and refreshes LaunchServices so Finder
# picks up the .md file association. Safe to run repeatedly — the previous
# bundle is removed first to avoid stale associations.
#
# Usage:
#   scripts/install-app.sh           # default: install to /Applications
#   scripts/install-app.sh ~/Applications

set -e

APP_NAME="MDE.app"

# Resolve the repo root from the script's own location so it works no matter
# where the user invokes it from.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_APP="$REPO_ROOT/src-tauri/target/release/bundle/macos/$APP_NAME"

INSTALL_DIR="${1:-/Applications}"

if [ ! -d "$SRC_APP" ]; then
  echo "error: $SRC_APP not found." >&2
  echo "       run \`pnpm tauri build\` first." >&2
  exit 1
fi

if [ ! -d "$INSTALL_DIR" ]; then
  echo "error: install directory $INSTALL_DIR does not exist." >&2
  exit 1
fi

DEST="$INSTALL_DIR/$APP_NAME"

# Use sudo only if the destination requires it.
SUDO=""
if [ ! -w "$INSTALL_DIR" ]; then
  if command -v sudo >/dev/null 2>&1; then
    echo "$INSTALL_DIR is not writable — re-running with sudo."
    SUDO="sudo"
  else
    echo "error: $INSTALL_DIR is not writable and sudo is unavailable." >&2
    exit 1
  fi
fi

echo "removing any existing $DEST"
$SUDO rm -rf "$DEST"

echo "copying $SRC_APP -> $DEST"
$SUDO cp -R "$SRC_APP" "$DEST"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  echo "refreshing LaunchServices"
  "$LSREGISTER" -f "$DEST"
else
  echo "warning: lsregister not found — Finder may not pick up the .md association until reboot." >&2
fi

echo "installed: $DEST"
