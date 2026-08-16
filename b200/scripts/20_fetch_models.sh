#!/usr/bin/env bash
# Downloads model weights in a detached tmux session and tells you how to watch.
#
#   ./20_fetch_models.sh --model ltx            # resolve + download in tmux
#   ./20_fetch_models.sh --model ltx --list     # resolve and print the file tree only
#   ./20_fetch_models.sh --model ltx --fg       # run in the foreground
#   ./20_fetch_models.sh --model all
#
# Resolution is done by b200/pipeline/fetch_models.py against the live HF API,
# because the repo ids in config/models.yaml are candidates rather than verified
# facts. Nothing is downloaded until a repo is confirmed to exist.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MODEL=""
MODE="download"
FOREGROUND=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="${2:?--model needs a value}"; shift 2 ;;
    --list)  MODE="list"; shift ;;
    --fg)    FOREGROUND=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -z "${MODEL}" ]] && die "--model is required (ltx | wan | upscale | all)"

need_cmd curl
PY="$(comfy_python)"
mkdir -p "${MODELS_DIR}"

if [[ -z "${HF_TOKEN:-}" ]]; then
  warn "HF_TOKEN not set. Public repos are fine; gated ones (some Wan/LTX releases) will 401."
  warn "Set it in b200/.env  ->  HF_TOKEN=hf_xxx"
fi

# Sanity-check egress before committing to a long-running tmux job, so a blocked
# network fails in two seconds instead of looking like a stalled download.
if ! curl -fsS --max-time 15 -o /dev/null "https://huggingface.co/api/models/gpt2"; then
  die "cannot reach huggingface.co. Check proxy/firewall (this is the failure the authoring sandbox hit).
     If you are behind a proxy: export HTTPS_PROXY=... and re-run."
fi

CMD=("${PY}" -m pipeline.fetch_models
     --config "${B200_ROOT}/config/models.yaml"
     --dest "${MODELS_DIR}"
     --model "${MODEL}")
[[ "${MODE}" == "list" ]] && CMD+=(--list)

export PYTHONPATH="${B200_ROOT}:${PYTHONPATH:-}"

if [[ "${MODE}" == "list" || "${FOREGROUND}" == "1" ]]; then
  exec "${CMD[@]}"
fi

need_cmd tmux
LOG="${B200_WORKDIR}/logs/fetch-${MODEL}-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$(dirname "${LOG}")"

SESSION="${TMUX_DOWNLOAD_SESSION}"
if tmux has-session -t "${SESSION}" 2>/dev/null; then
  die "tmux session '${SESSION}' already exists — a download may be running.
     watch it:  tmux attach -t ${SESSION}
     kill it:   tmux kill-session -t ${SESSION}"
fi

# `script` keeps the progress bars rendering into the log file.
tmux new-session -d -s "${SESSION}" \
  "script -q -e -c '$(printf '%q ' "${CMD[@]}")' '${LOG}'"

ok "download started in tmux session '${SESSION}'"
cat <<EOF

  watch live      tmux attach -t ${SESSION}          (detach with Ctrl-b then d)
  tail the log    tail -f ${LOG}
  disk growth     watch -n30 du -sh ${MODELS_DIR}
  is it running   tmux has-session -t ${SESSION} && echo running || echo finished
  stop it         tmux kill-session -t ${SESSION}

Downloads resume on re-run — huggingface_hub keeps partial blobs in
${HF_HOME:-~/.cache/huggingface}, so an interrupted pull continues where it stopped.
EOF
