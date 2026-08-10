#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../packages/agent"
export EVE_GATEWAY_DISABLED=1
bunx eve eval --strict --junit .eve/junit.xml "$@"
