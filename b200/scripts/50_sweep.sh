#!/usr/bin/env bash
# Phase 2 tuning helper. Runs a parameter grid on one keyframe in a tmux session
# and leaves an index.md you can review clip by clip.
#
#   ./50_sweep.sh --image ../keyframes/scene01_start.png
#   ./50_sweep.sh --image a.png --image-end b.png --axis max_shift=1.3,2.05,2.6
#   ./50_sweep.sh --image a.png --preset camera --fg
#
# Any extra arguments are passed straight to `python -m pipeline.sweep`.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

FOREGROUND=0
PASS_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fg) FOREGROUND=1; shift ;;
    --preset) PASS_ARGS+=(--base-preset "${2:?}"); shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; "$(comfy_python)" -m pipeline.sweep --help; exit 0 ;;
    *) PASS_ARGS+=("$1"); shift ;;
  esac
done

PY="$(comfy_python)"
export PYTHONPATH="${B200_ROOT}:${PYTHONPATH:-}"
PASS_ARGS+=(--url "$(comfy_url)")

if (( FOREGROUND )); then
  exec "${PY}" -m pipeline.sweep "${PASS_ARGS[@]}"
fi

need_cmd tmux
SESSION="ltx-sweep"
LOG="${B200_WORKDIR}/logs/sweep-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$(dirname "${LOG}")"

tmux has-session -t "${SESSION}" 2>/dev/null && \
  die "tmux session '${SESSION}' already running. Watch: tmux attach -t ${SESSION}"

tmux new-session -d -s "${SESSION}" -c "${B200_ROOT}" \
  "script -q -e -c '$(printf '%q ' "${PY}" -m pipeline.sweep "${PASS_ARGS[@]}")' '${LOG}'"

ok "sweep started in tmux session '${SESSION}'"
echo "  watch    tmux attach -t ${SESSION}     (detach: Ctrl-b then d)"
echo "  log      tail -f ${LOG}"
echo "  results  ${B200_ROOT}/sweeps/"
