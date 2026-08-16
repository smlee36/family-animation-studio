#!/usr/bin/env bash
# Phase 1 completion check: one image in, one clip out, with timing and VRAM.
#
#   ./40_smoke_test.sh                      # generated placeholder image
#   ./40_smoke_test.sh --image path/to.png  # your own keyframe
#   ./40_smoke_test.sh --preset draft       # faster
#
# Runs the workflow doctor first, because a missing node or a wrong model
# filename is by far the most likely reason the first run fails, and the doctor
# names the exact fix instead of leaving you with a stack trace.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

IMAGE=""
PRESET="draft"
MODEL="ltx"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="${2:?}"; shift 2 ;;
    --preset) PRESET="${2:?}"; shift 2 ;;
    --model) MODEL="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

PY="$(comfy_python)"
export PYTHONPATH="${B200_ROOT}:${PYTHONPATH:-}"
URL="$(comfy_url)"

log "1/4 ComfyUI reachable?"
wait_for_comfy 60
curl -fsS "${URL}/system_stats" | "${PY}" -c '
import json, sys
stats = json.load(sys.stdin)
for d in stats.get("devices", []):
    total = d.get("vram_total", 0) / 1024**3
    free = d.get("vram_free", 0) / 1024**3
    print(f"  {d.get(\"name\")}: {total:.1f} GiB total, {free:.1f} GiB free")
'

log "2/4 workflow validation against the live node set"
if ! "${PY}" -m pipeline.doctor --url "${URL}"; then
  warn "the doctor found problems. Fix those first — the run below will fail otherwise."
  warn "tip: ${PY} -m pipeline.doctor --url ${URL} --list-nodes ltx --verbose"
  exit 1
fi

log "3/4 preparing the smoke-test scene"
SMOKE_KF="${B200_WORKDIR}/smoke/keyframes"
SMOKE_OUT="${B200_WORKDIR}/smoke/clips"
rm -rf "${B200_WORKDIR}/smoke"
mkdir -p "${SMOKE_KF}" "${SMOKE_OUT}"

if [[ -n "${IMAGE}" ]]; then
  [[ -f "${IMAGE}" ]] || die "image not found: ${IMAGE}"
  cp "${IMAGE}" "${SMOKE_KF}/smoke_start.png"
else
  log "  no --image given; generating a placeholder"
  "${PY}" -m pipeline.testimage "${SMOKE_KF}/smoke_start.png" --width 1280 --height 704 >/dev/null
fi
cat > "${SMOKE_KF}/smoke_prompt.txt" <<'EOF'
a soft watercolour illustration, gentle natural motion, slow drifting light,
calm atmosphere, consistent hand-painted texture
EOF

log "4/4 generating (preset=${PRESET}, model=${MODEL})"
START="$(date +%s)"
set +e
"${PY}" -m pipeline.batch_generate \
  --keyframes "${SMOKE_KF}" \
  --clips "${SMOKE_OUT}" \
  --url "${URL}" \
  --model "${MODEL}" \
  --preset "${PRESET}" \
  --retries 0 \
  --seed 1234
RC=$?
set -e
ELAPSED=$(( $(date +%s) - START ))

echo
if [[ ${RC} -ne 0 ]]; then
  warn "smoke test FAILED after ${ELAPSED}s"
  warn "report: ${SMOKE_OUT}/_reports/"
  warn "server log: tmux attach -t ${TMUX_SERVER_SESSION}  (or ${B200_WORKDIR}/logs/comfyui-latest.log)"
  exit 1
fi

CLIP="$(find "${SMOKE_OUT}" -maxdepth 1 -name '*.mp4' | head -1)"
ok "smoke test passed in ${ELAPSED}s"
echo
echo "  output      ${CLIP}"
[[ -n "${CLIP}" ]] && echo "  size        $(du -h "${CLIP}" | cut -f1)"
if command -v ffprobe >/dev/null 2>&1 && [[ -n "${CLIP}" ]]; then
  echo "  probe       $(ffprobe -v error -select_streams v:0 \
      -show_entries stream=width,height,nb_frames,r_frame_rate,duration \
      -of default=noprint_wrappers=1:nokey=1 "${CLIP}" | paste -sd' ')"
  echo "              (width height frames fps duration)"
fi
echo "  vram after  $(curl -fsS "${URL}/system_stats" | "${PY}" -c '
import json, sys
for d in json.load(sys.stdin).get("devices", []):
    t = d.get("vram_total", 0) / 1024**3
    f = d.get("vram_free", 0) / 1024**3
    print(f"{t - f:.1f}/{t:.1f} GiB used", end="")
')"
echo "  report      ${SMOKE_OUT}/_reports/"
echo
echo "next: put real keyframes in b200/keyframes/ and run"
echo "      ${B200_ROOT}/scripts/50_sweep.sh --image <keyframe>     # tune presets"
echo "      ${PY} -m pipeline.batch_generate                        # batch run"
