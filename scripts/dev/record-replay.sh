#!/usr/bin/env bash
# Record a slow walkthrough of a public replay (no credentials: anonymous viewer).
#   scripts/dev/record-replay.sh <replayId> <output.webm>
set -euo pipefail
cd "$(dirname "$0")/../.."
S=rec-replay-$$
URL="https://converge-preview-dev.converge-42.workers.dev/replay/$1"
js() { agent-browser --session "$S" eval "$1" 2>/dev/null | tail -1; }
agent-browser --session "$S" open "$URL" >/dev/null 2>&1
agent-browser --session "$S" set viewport 1440 900 >/dev/null 2>&1
agent-browser --session "$S" wait --load networkidle >/dev/null 2>&1
agent-browser --session "$S" record start "$2" >/dev/null 2>&1
sleep 4
h=$(js "document.documentElement.scrollHeight" | tr -d '"')
for y in $(seq 0 300 "${h%.*}"); do js "window.scrollTo({top:$y,behavior:'smooth'})" >/dev/null; sleep 1.4; done
sleep 3
agent-browser --session "$S" record stop >/dev/null 2>&1
agent-browser --session "$S" close >/dev/null 2>&1
ls -la "$2"
