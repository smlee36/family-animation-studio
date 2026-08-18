#!/usr/bin/env bash
set -euo pipefail

ROOT="${WAN22_ROOT:-/NHNHOME/WORKSPACE/26mss002_U1A/wan22}"
cd "$ROOT"
if [ ! -d Wan2.2/.git ]; then
  git clone https://github.com/Wan-Video/Wan2.2.git Wan2.2
fi
python3 -m venv --system-site-packages .venv
.venv/bin/pip install --upgrade pip setuptools wheel
# Blackwell uses the PyTorch SDPA path. flash-attn is intentionally omitted when
# its source build is incompatible with the current CUDA/PyTorch nightly.
grep -v -E '^flash[_-]attn' Wan2.2/requirements.txt > requirements-blackwell.txt
.venv/bin/pip install -r requirements-blackwell.txt
.venv/bin/pip install decord peft
chmod 700 download-model.sh run_job.py cache-model-local.sh
./download-model.sh
(cd Wan2.2 && ../.venv/bin/python -c 'import torch, wan; print("wan22 runtime ready", torch.__version__)')
touch .ready
