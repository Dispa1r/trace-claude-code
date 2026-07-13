#!/bin/zsh
set -eu

SCRIPT_DIR=${0:A:h}
DEFAULT_SOURCE=/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
SOURCE=${CLAUDE_BINARY:-$DEFAULT_SOURCE}
DESTINATION=${1:-$SCRIPT_DIR/.work/claude-hookable}

mkdir -p "${DESTINATION:h}"

if [[ -x "$DESTINATION" && "$SOURCE" -ot "$DESTINATION" ]]; then
  codesign --verify --strict --verbose=2 "$DESTINATION"
  print -r -- "$DESTINATION"
  exit 0
fi

rm -f "$DESTINATION"

# APFS clone-copy avoids allocating another full 200+ MB payload when possible.
if ! cp -c "$SOURCE" "$DESTINATION" 2>/dev/null; then
  cp "$SOURCE" "$DESTINATION"
fi

chmod 0755 "$DESTINATION"
codesign --force --sign - \
  --entitlements "$SCRIPT_DIR/claude-hook.entitlements.plist" \
  "$DESTINATION"
codesign --verify --strict --verbose=2 "$DESTINATION"

# Give macOS amfid/dyld time to observe the replacement signature before Frida
# asks launchd to spawn the copy. Subsequent runs reuse the verified copy.
sleep 5

print -r -- "$DESTINATION"
