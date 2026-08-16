#!/usr/bin/env bash
set -euo pipefail

ROOT="${LTX25_ROOT:-/NHNHOME/WORKSPACE/26mss002_U1A/ltx25}"
TOKEN_FILE="${LTX_API_TOKEN_FILE:-$ROOT/.ltx_api_token}"
LOG="$ROOT/logs/worker-keepalive.log"

if ! curl -fsS -m 10 -o /dev/null -H "Authorization: Bearer $(cat "$TOKEN_FILE")" http://127.0.0.1:8787/ltx/health; then
  printf '%s worker health failed; restarting\n' "$(date -Is)" >> "$LOG"
  tmux kill-session -t ltx25-worker 2>/dev/null || true
  "$ROOT/project-config/worker/start-worker.sh" >> "$LOG" 2>&1
fi
