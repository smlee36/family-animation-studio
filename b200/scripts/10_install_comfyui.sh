#!/usr/bin/env bash
# Installs ComfyUI + the custom nodes needed for LTX / Wan image-to-video.
#
# The one non-obvious thing this script does: it pins the torch stack that the
# NGC container already provides, so that ComfyUI's own requirements.txt cannot
# quietly replace the Blackwell-capable build with a generic PyPI wheel that has
# no sm_100 kernels. That failure mode is silent until inference is 20x slow or
# dies with "no kernel image is available for execution on the device".

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

need_cmd git
PY="$(comfy_python)"
log "using python: ${PY} ($(${PY} --version 2>&1))"

mkdir -p "${B200_WORKDIR}"

# ---------------------------------------------------------------- ComfyUI core
if [[ -d "${COMFY_DIR}/.git" ]]; then
  log "ComfyUI already present, updating"
  git -C "${COMFY_DIR}" pull --ff-only || warn "could not fast-forward ComfyUI; leaving as is"
else
  log "cloning ComfyUI -> ${COMFY_DIR}"
  git clone https://github.com/comfyanonymous/ComfyUI.git "${COMFY_DIR}"
fi

# ------------------------------------------------------------ torch protection
CONSTRAINTS="${B200_WORKDIR}/torch-constraints.txt"
log "freezing the installed torch stack into ${CONSTRAINTS}"
"${PY}" - "${CONSTRAINTS}" <<'PYEOF'
import sys
from importlib.metadata import version, PackageNotFoundError

out = []
for pkg in ("torch", "torchvision", "torchaudio", "triton", "pytorch-triton"):
    try:
        out.append(f"{pkg}=={version(pkg)}")
    except PackageNotFoundError:
        pass
if not out:
    print("WARNING: no torch found to pin; ComfyUI will install its own.", file=sys.stderr)
with open(sys.argv[1], "w") as fh:
    fh.write("\n".join(out) + ("\n" if out else ""))
print("pinned:", ", ".join(out) or "(nothing)")
PYEOF

pip_install() { "${PY}" -m pip install --no-cache-dir -c "${CONSTRAINTS}" "$@"; }

log "installing ComfyUI requirements"
pip_install -r "${COMFY_DIR}/requirements.txt"

# ------------------------------------------------------------- custom nodes
# Data-driven so you can add/remove without editing this script.
# Format: <name>|<git url>
NODES_FILE="${B200_ROOT}/config/custom_nodes.txt"
CUSTOM_DIR="${COMFY_DIR}/custom_nodes"
mkdir -p "${CUSTOM_DIR}"

if [[ ! -f "${NODES_FILE}" ]]; then
  die "missing ${NODES_FILE}"
fi

while IFS='|' read -r name url; do
  [[ -z "${name// }" || "${name:0:1}" == "#" ]] && continue
  name="${name// }"; url="${url// }"
  target="${CUSTOM_DIR}/${name}"
  if [[ -d "${target}/.git" ]]; then
    log "custom node ${name}: updating"
    git -C "${target}" pull --ff-only || warn "${name}: could not fast-forward"
  else
    log "custom node ${name}: cloning"
    git clone --depth 1 "${url}" "${target}" || { warn "${name}: clone failed, skipping"; continue; }
  fi
  if [[ -f "${target}/requirements.txt" ]]; then
    pip_install -r "${target}/requirements.txt" \
      || warn "${name}: requirements failed. If it was a kernel package (flash-attn, xformers, ...) this is expected on Blackwell — see NOTES.md; ComfyUI falls back to SDPA."
  fi
done < "${NODES_FILE}"

# ------------------------------------------------------------------- verify
log "verifying the torch stack survived the installs"
"${PY}" - <<'PYEOF'
import sys, torch
arches = torch.cuda.get_arch_list()
print(f"  torch {torch.__version__} (cuda {torch.version.cuda})")
print(f"  arch list: {' '.join(arches)}")
if torch.cuda.is_available():
    cap = torch.cuda.get_device_capability(0)
    tag = f"sm_{cap[0]}{cap[1]}"
    if cap[0] >= 10 and not any(a.startswith(tag) for a in arches):
        print(f"  FATAL: torch lost its {tag} kernels during install.", file=sys.stderr)
        print("  A dependency force-reinstalled torch from PyPI. Reinstall the NGC build", file=sys.stderr)
        print("  or: pip install --force-reinstall torch --index-url https://download.pytorch.org/whl/cu128", file=sys.stderr)
        sys.exit(1)
else:
    print("  (no CUDA device visible in this context — cannot fully verify)")
PYEOF

mkdir -p "${MODELS_DIR}"
ok "ComfyUI installed at ${COMFY_DIR}"
echo
echo "next: ${B200_ROOT}/scripts/20_fetch_models.sh --model ltx"
