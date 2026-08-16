#!/usr/bin/env bash
set -euo pipefail

ROOT="${LTX25_ROOT:-/NHNHOME/WORKSPACE/26mss002_U1A/ltx25}"
SESSION="${LTX25_COMFY_SESSION:-ltx25-comfy}"
PORT="${LTX25_COMFY_PORT:-8188}"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "ComfyUI is already running in tmux session: $SESSION"
  exit 0
fi

tmux new-session -d -s "$SESSION" \
  "cd '$ROOT/ComfyUI' && '$ROOT/LTX-2/.venv/bin/python' main.py --listen 0.0.0.0 --port '$PORT' --extra-model-paths-config '$ROOT/project-config/extra_model_paths.yaml' > '$ROOT/logs/comfyui.log' 2>&1"

echo "Started ComfyUI in tmux session: $SESSION (port $PORT)"
echo "Logs: $ROOT/logs/comfyui.log"
