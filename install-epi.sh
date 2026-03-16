#!/usr/bin/env bash
# Install the effect-native pi fork as "epi" globally via bun.
#
# Usage: ./install-epi.sh
#
# This builds the coding-agent package and its dependencies,
# then creates a global "epi" symlink pointing to dist/cli.js.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CODING_AGENT="$SCRIPT_DIR/packages/coding-agent"
CLI="$CODING_AGENT/dist/cli.js"
BUN_BIN="$HOME/.bun/bin"
LINK="$BUN_BIN/epi"

echo "==> Building packages..."
cd "$SCRIPT_DIR"

# Build in dependency order
(cd packages/tui && npm run build)
(cd packages/ai && npm run build)
(cd packages/agent && npm run build)
(cd packages/coding-agent && npm run build)

echo "==> Build complete."

# Verify the CLI exists
if [ ! -f "$CLI" ]; then
  echo "ERROR: $CLI not found after build" >&2
  exit 1
fi

# Create the symlink
mkdir -p "$BUN_BIN"
ln -sf "$CLI" "$LINK"
chmod +x "$CLI"

echo "==> Installed: $LINK -> $CLI"
echo ""
epi -v && echo "epi is ready! Run: epi --help"
