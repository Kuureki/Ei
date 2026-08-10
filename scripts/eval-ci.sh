#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../packages/agent"
bunx eve eval --strict --junit .eve/junit.xml "$@"
