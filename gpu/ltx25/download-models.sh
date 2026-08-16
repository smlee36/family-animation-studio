#!/usr/bin/env bash
set -euo pipefail

ROOT="${LTX25_ROOT:-/NHNHOME/WORKSPACE/26mss002_U1A/ltx25}"
HF_HOME="${HF_HOME:-/NHNHOME/WORKSPACE/26mss002_U1A/hf}"
export HF_HOME

mkdir -p "$ROOT/models/ltx-2.5"

hf download Lightricks/LTX-2.5 \
  diffusion_models/ltx-2.5-22b-dev-transformer-bf16.safetensors \
  text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors \
  vae/ltx-2.5-video-vae-bf16.safetensors \
  vae/ltx-2.5-audio-vae-bf16.safetensors \
  latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors \
  latent_upscale_models/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors \
  loras/ltx-2.5-22b-distilled-lora-450-bf16.safetensors \
  --local-dir "$ROOT/models/ltx-2.5"

