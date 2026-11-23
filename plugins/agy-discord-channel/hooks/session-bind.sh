#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ -x "$PLUGIN_DIR/bin/agy-discord" ]; then
  "$PLUGIN_DIR/bin/agy-discord" bind-hook 2>/dev/null || printf '{}\n'
else
  printf '{}\n'
fi
exit 0
