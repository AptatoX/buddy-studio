#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found in PATH."
  exit 1
fi

node "tools/official-buddy-lab/start-buddy-studio.mjs"
