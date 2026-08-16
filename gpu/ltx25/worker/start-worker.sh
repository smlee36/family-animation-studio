#!/usr/bin/env bash
set -euo pipefail

ROOT="${LTX25_ROOT:-/NHNHOME/WORKSPACE/26mss002_U1A/ltx25}"
SESSION="${LTX25_WORKER_SESSION:-ltx25-worker}"
PORT="${LTX25_WORKER_PORT:-8787}"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "LTX worker is already running in tmux session: $SESSION"
  exit 0
fi

tmux new-session -d -s "$SESSION" \
  "cd '$ROOT/project-config/worker' && '$ROOT/worker-venv/bin/python' -m uvicorn app:app --host 127.0.0.1 --port '$PORT' > '$ROOT/logs/worker.log' 2>&1"

echo "Started LTX worker in tmux session: $SESSION (port $PORT)"
