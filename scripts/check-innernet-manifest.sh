#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

grep -q '^SAVE_TOOL = innernet__' docs/innernet-tools.md   || { echo "SAVE_TOOL missing"; exit 1; }
grep -q '^SEARCH_TOOL = innernet__' docs/innernet-tools.md || { echo "SEARCH_TOOL missing"; exit 1; }

echo "manifest ok"
