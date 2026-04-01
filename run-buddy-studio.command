#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found in PATH."
  exit 1
fi

open "http://127.0.0.1:4317"
node "tools/official-buddy-lab/start-buddy-studio.mjs"
