#!/bin/sh
# Install (or re-sync) the extension as a plain file in the user extensions directory.
# Remove it with: rm ~/.pi/agent/extensions/ime-cursor-batch.ts
set -e
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dst="${PI_AGENT_DIR:-$HOME/.pi/agent}/extensions/ime-cursor-batch.ts"
mkdir -p "$(dirname "$dst")"
cp "$here/extensions/ime-cursor-batch.ts" "$dst"
echo "installed -> $dst"
