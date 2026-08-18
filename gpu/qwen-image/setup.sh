#!/usr/bin/env bash
set -euo pipefail

ROOT="${QWEN_IMAGE_ROOT:-/NHNHOME/WORKSPACE/26mss002_U1A/qwen-image}"
cd "$ROOT"
python3 -m venv --system-site-packages .venv
.venv/bin/pip install --upgrade pip setuptools wheel
.venv/bin/pip install -r requirements.txt
chmod 700 download-model.sh run_job.py
./download-model.sh
.venv/bin/python -c 'from diffusers import QwenImageEditPlusPipeline; import torch; print("qwen-image runtime ready", torch.__version__)'
touch .ready
