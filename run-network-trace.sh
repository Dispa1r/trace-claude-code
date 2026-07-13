#!/bin/zsh
set -eu

SCRIPT_DIR=${0:A:h}
TARGET=$($SCRIPT_DIR/prepare-hookable-copy.sh)
HOOKS=${CC_HOOKS:-network}

exec lldb -Q -b \
  -o "command script import $SCRIPT_DIR/native_lldb.py" \
  -o "cc-hook-install $HOOKS" \
  -o run \
  -- "$TARGET" "$@"
