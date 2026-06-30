#!/usr/bin/env bash
#
# Registers the ClaudeMonkey native-messaging host with Firefox.
#
# - resolves the `claude` binary and records it in bridge/config.json
# - makes host.js executable
# - installs claudemonkey.bridge.json into Firefox's native-messaging-hosts dir
#
set -euo pipefail

HOST_NAME="claudemonkey.bridge"
EXTENSION_ID="claudemonkey@local"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_JS="$DIR/host.js"

# 1. Resolve the claude binary.
CLAUDE_BIN="${CLAUDEMONKEY_CLAUDE_BIN:-}"
if [ -z "$CLAUDE_BIN" ]; then
  # `claude` is often a shell alias (env -u ANTHROPIC_API_KEY claude); resolve the
  # real executable instead, since the native host won't see shell aliases.
  CLAUDE_BIN="$(command -v claude || true)"
fi
if [ -z "$CLAUDE_BIN" ]; then
  echo "ERROR: could not find the 'claude' CLI on PATH." >&2
  echo "Install Claude Code or set CLAUDEMONKEY_CLAUDE_BIN to its path, then re-run." >&2
  exit 1
fi
# Keep the resolved path as-is (often ~/.local/bin/claude, a stable symlink that
# survives Claude Code version upgrades) rather than pinning a versioned target.
echo "Using claude binary: $CLAUDE_BIN"

# 1b. Optional account profile (CLAUDE_CONFIG_DIR). The native host can't see shell
# aliases like `claude-robert`, so we record the profile dir explicitly and host.js
# exports it as CLAUDE_CONFIG_DIR when launching claude. Set CLAUDEMONKEY_CLAUDE_CONFIG_DIR
# (or your current CLAUDE_CONFIG_DIR) to use a non-default profile; leave empty for ~/.claude.
CLAUDE_CONFIG_DIR_VAL="${CLAUDEMONKEY_CLAUDE_CONFIG_DIR:-${CLAUDE_CONFIG_DIR:-}}"

# 2. Write config.json consumed by host.js.
if [ -n "$CLAUDE_CONFIG_DIR_VAL" ]; then
  echo "Using claude config dir: $CLAUDE_CONFIG_DIR_VAL"
  printf '{\n  "claudeBin": "%s",\n  "claudeConfigDir": "%s"\n}\n' "$CLAUDE_BIN" "$CLAUDE_CONFIG_DIR_VAL" > "$DIR/config.json"
else
  printf '{\n  "claudeBin": "%s"\n}\n' "$CLAUDE_BIN" > "$DIR/config.json"
fi

# 3. Make host.js executable.
chmod +x "$HOST_JS"

# 4. Install the native-messaging host manifest.
case "$(uname -s)" in
  Darwin) TARGET_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
  *)      TARGET_DIR="$HOME/.mozilla/native-messaging-hosts" ;;
esac
mkdir -p "$TARGET_DIR"
MANIFEST="$TARGET_DIR/$HOST_NAME.json"
cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "ClaudeMonkey bridge to the Claude Code CLI",
  "path": "$HOST_JS",
  "type": "stdio",
  "allowed_extensions": ["$EXTENSION_ID"]
}
EOF

echo "Installed native-messaging host manifest: $MANIFEST"
echo "Done. Reload the ClaudeMonkey extension in Firefox if it was already running."
