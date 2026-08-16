#!/usr/bin/env bash
# Phase 1 gate. Verifies the host/container can actually run Blackwell kernels
# BEFORE anything large gets downloaded. Everything here is checked at runtime;
# nothing about the platform is assumed.
#
# Usage:  ./00_preflight.sh [--require-gpu]
#   --require-gpu  exit non-zero if no usable sm_100 device is found (use in CI
#                  and before 20_fetch_models.sh; the default is to warn only so
#                  the script is still useful for inspecting a host).

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REQUIRE_GPU=0
[[ "${1:-}" == "--require-gpu" ]] && REQUIRE_GPU=1

FAILED=0
fail() { warn "$*"; FAILED=1; }

log "1/6 driver and GPU"
if ! command -v nvidia-smi >/dev/null 2>&1; then
  fail "nvidia-smi not found. On the host install the NVIDIA driver; inside a container run with --gpus all and the NVIDIA Container Toolkit."
else
  nvidia-smi --query-gpu=index,name,driver_version,memory.total,compute_cap \
             --format=csv,noheader || fail "nvidia-smi query failed"

  # Blackwell datacenter parts need a recent driver branch. 570 is the first
  # branch that ships CUDA 12.8 userspace; older branches cannot load sm_100.
  DRV="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | tr -d ' ')"
  DRV_MAJOR="${DRV%%.*}"
  if [[ -n "${DRV_MAJOR}" ]] && (( DRV_MAJOR < 570 )); then
    fail "driver ${DRV} is older than the 570 branch; Blackwell (sm_100) needs CUDA 12.8+ userspace. Upgrade the driver."
  else
    ok "driver ${DRV}"
  fi

  CC="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d ' ')"
  case "${CC}" in
    10.*) ok "compute capability ${CC} (Blackwell)" ;;
    "")   fail "could not read compute capability" ;;
    *)    warn "compute capability ${CC} is not sm_100 — this is not a B200. The stack still works, but the tuned presets were sized for 180GB HBM3e." ;;
  esac
fi

log "2/6 CUDA toolkit / runtime"
if command -v nvcc >/dev/null 2>&1; then
  NVCC_VER="$(nvcc --version | sed -n 's/.*release \([0-9.]*\).*/\1/p')"
  ok "nvcc ${NVCC_VER}"
  # 12.8 is the first toolkit with sm_100 codegen.
  awk -v v="${NVCC_VER}" 'BEGIN{split(v,a,"."); if (a[1]<12 || (a[1]==12 && a[2]<8)) exit 1}' \
    || fail "CUDA toolkit ${NVCC_VER} < 12.8 cannot generate sm_100 code."
else
  warn "nvcc not on PATH (fine if you only run prebuilt wheels; required to compile custom kernels)"
fi

log "3/6 pytorch <-> Blackwell"
PY="$(comfy_python)"
if [[ -z "${PY}" ]]; then
  fail "no python3 found"
else
  "${PY}" - <<'PYEOF' || FAILED=1
import sys
try:
    import torch
except ModuleNotFoundError:
    print("  torch not installed in this interpreter", file=sys.stderr)
    sys.exit(1)

print(f"  torch {torch.__version__}  cuda {torch.version.cuda}")
arches = torch.cuda.get_arch_list()
print(f"  compiled arch list: {' '.join(arches)}")

problems = []
if not torch.cuda.is_available():
    problems.append("torch.cuda.is_available() is False")
else:
    cap = torch.cuda.get_device_capability(0)
    print(f"  device 0: {torch.cuda.get_device_name(0)} sm_{cap[0]}{cap[1]}")
    print(f"  vram: {torch.cuda.get_device_properties(0).total_memory/1024**3:.1f} GiB")
    # The decisive check: a wheel built without sm_100 will fall back to PTX JIT
    # or fail outright on a B200.
    if cap[0] >= 10 and not any(a.startswith(f"sm_{cap[0]}{cap[1]}") for a in arches):
        problems.append(
            f"this torch build has no sm_{cap[0]}{cap[1]} kernels. "
            "Install a CUDA 12.8+ build (NGC container, or the cu128/cu129 wheel index)."
        )
    # Prove it end to end rather than trusting the metadata.
    try:
        a = torch.randn(512, 512, device="cuda", dtype=torch.bfloat16)
        (a @ a).sum().item()
        torch.cuda.synchronize()
        print("  bf16 matmul on device: OK")
    except Exception as e:  # noqa: BLE001
        problems.append(f"bf16 matmul failed on device: {e}")

for p in problems:
    print(f"  PROBLEM: {p}", file=sys.stderr)
sys.exit(1 if problems else 0)
PYEOF
fi

log "4/6 attention backend"
"${PY}" - <<'PYEOF' 2>/dev/null || warn "attention probe skipped (torch unavailable)"
import torch
if torch.cuda.is_available():
    from torch.nn.functional import scaled_dot_product_attention as sdpa
    q = torch.randn(1, 8, 256, 64, device="cuda", dtype=torch.bfloat16)
    try:
        sdpa(q, q, q); torch.cuda.synchronize()
        print("  SDPA on cuda: OK (this is the supported fallback if flash-attn has no Blackwell build)")
    except Exception as e:
        print(f"  SDPA FAILED: {e}")
    try:
        import flash_attn
        print(f"  flash-attn {flash_attn.__version__} present")
    except ModuleNotFoundError:
        print("  flash-attn not installed — fine, ComfyUI will use SDPA. See NOTES.md.")
PYEOF

log "5/6 disk"
df -h "${B200_WORKDIR%/*}" 2>/dev/null || df -h .
AVAIL_GB="$(df -BG --output=avail "${B200_WORKDIR%/*}" 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)"
# Full-precision video weights plus VAE/text-encoder plus output clips.
if [[ -n "${AVAIL_GB}" ]] && (( AVAIL_GB < 250 )); then
  warn "only ${AVAIL_GB}GB free. Full-precision LTX + Wan 2.2 side by side wants ~250GB+. Set B200_WORKDIR to a bigger volume."
else
  ok "${AVAIL_GB}GB free"
fi

log "6/6 tooling"
for c in git curl tmux; do
  if command -v "$c" >/dev/null 2>&1; then ok "$c"; else fail "missing $c"; fi
done
command -v ffmpeg >/dev/null 2>&1 && ok "ffmpeg" || warn "ffmpeg missing (needed for mp4 muxing / frame extraction)"

echo
if (( FAILED )); then
  if (( REQUIRE_GPU )); then
    die "preflight FAILED — fix the problems above before downloading weights."
  fi
  warn "preflight found problems (see above). Re-run with --require-gpu to make this fatal."
  exit 1
fi
ok "preflight passed"
