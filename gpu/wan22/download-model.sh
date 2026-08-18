#!/usr/bin/env bash
set -euo pipefail

ROOT="${WAN22_ROOT:-/NHNHOME/WORKSPACE/26mss002_U1A/wan22}"
mkdir -p "$ROOT/models" "$ROOT/logs" "$ROOT/jobs"
if [ ! -d "$ROOT/Wan2.2/.git" ]; then
  git clone https://github.com/Wan-Video/Wan2.2.git "$ROOT/Wan2.2"
fi
if ! command -v hf >/dev/null 2>&1; then
  python3 -m pip install --user --upgrade "huggingface_hub[cli]"
fi
hf download Wan-AI/Wan2.2-I2V-A14B --local-dir "$ROOT/models/Wan2.2-I2V-A14B"
echo "Wan 2.2 model ready: $ROOT/models/Wan2.2-I2V-A14B"
