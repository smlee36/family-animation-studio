#!/usr/bin/env bash
set -euo pipefail

ROOT="${QWEN_IMAGE_ROOT:-/NHNHOME/WORKSPACE/26mss002_U1A/qwen-image}"
MODEL_DIR="$ROOT/models/Qwen-Image-Edit-2511"
mkdir -p "$MODEL_DIR" "$ROOT/logs" "$ROOT/jobs"

if ! command -v hf >/dev/null 2>&1; then
  python3 -m pip install --user --upgrade "huggingface_hub[cli]"
fi

hf download Qwen/Qwen-Image-Edit-2511 --local-dir "$MODEL_DIR"
echo "Qwen Image model ready: $MODEL_DIR"
