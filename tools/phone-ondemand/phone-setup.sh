#!/usr/bin/env bash
# Uses installed software only. No downloads, no autostart, no background service.
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
printf 'Architecture: '; uname -m
printf 'Node: '; node --version
if ! command -v opencode >/dev/null 2>&1; then
  echo 'BLOCKED: OpenCode is not installed in this phone environment. No plugin files changed.'
  echo 'An ARM64 Ubuntu-compatible OpenCode CLI must be installed separately before continuing.'
  exit 3
fi
opencode --version
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
SRC="$DSH_ROOT/profiles/web/node_modules/dsh-our-free-model/src"
if [[ ! -f "$SRC/opencode-bridge.js" ]]; then
  echo "BLOCKED: installed plugin has no bridge at $SRC. No files changed."
  exit 4
fi
node "$HERE/patch-ofm-ondemand.mjs" "$SRC"
node "$HERE/patch-ofm-ondemand.mjs" "$SRC" --apply
printf '\nDONE: restart DSH to load the patch. OpenCode service was not started by this script.\n'
printf 'After first use it stays running until stopped; this is not idle auto-stop.\n'
