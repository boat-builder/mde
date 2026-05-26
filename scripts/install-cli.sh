#!/bin/sh
# Installs a `mde` shim that opens files in the MDE.app bundle.
# Usage: ./scripts/install-cli.sh [target-dir]
#   target-dir defaults to /usr/local/bin (falls back to ~/.local/bin if not writable)

set -e

APP_NAME="MDE"
APP_PATH=""
for candidate in "/Applications/${APP_NAME}.app" "$HOME/Applications/${APP_NAME}.app"; do
  if [ -d "$candidate" ]; then
    APP_PATH="$candidate"
    break
  fi
done

if [ -z "$APP_PATH" ]; then
  echo "warning: ${APP_NAME}.app not found in /Applications or ~/Applications."
  echo "         install the .app first, then re-run this script."
  APP_PATH="/Applications/${APP_NAME}.app"
fi

TARGET_DIR="${1:-/usr/local/bin}"
if [ ! -w "$TARGET_DIR" ]; then
  echo "$TARGET_DIR is not writable — falling back to ~/.local/bin"
  TARGET_DIR="$HOME/.local/bin"
  mkdir -p "$TARGET_DIR"
fi

SHIM="$TARGET_DIR/mde"
cat > "$SHIM" <<'EOS'
#!/bin/sh
# mde — open markdown files in the MDE editor
if [ $# -eq 0 ]; then
  open -a "MDE"
  exit $?
fi

args=""
for f in "$@"; do
  case "$f" in
    /*) abs="$f" ;;
    *)  abs="$PWD/$f" ;;
  esac
  args="$args \"$abs\""
done

eval open -a \"MDE\" --args $args
EOS
chmod +x "$SHIM"

echo "installed: $SHIM"
echo "app target: $APP_PATH"
case ":$PATH:" in
  *":$TARGET_DIR:"*) ;;
  *) echo "note: $TARGET_DIR is not on \$PATH — add it to your shell profile." ;;
esac
