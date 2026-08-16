#!/usr/bin/env bash
# Shared helpers for the B200 video-generation scripts.
# Source this, do not execute it.

set -euo pipefail

B200_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export B200_ROOT

# Where big things live. Override in .env if the model store is on another volume.
: "${B200_WORKDIR:=${B200_ROOT}/.work}"
: "${COMFY_DIR:=${B200_WORKDIR}/ComfyUI}"
: "${MODELS_DIR:=${B200_WORKDIR}/models}"
: "${COMFY_HOST:=0.0.0.0}"
: "${COMFY_PORT:=8188}"
: "${TMUX_DOWNLOAD_SESSION:=ltx-download}"
: "${TMUX_SERVER_SESSION:=comfyui}"

if [[ -f "${B200_ROOT}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "${B200_ROOT}/.env"; set +a
fi

export B200_WORKDIR COMFY_DIR MODELS_DIR COMFY_HOST COMFY_PORT

_c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
log()  { printf '%s %s\n' "$(_c '1;36' '==>')" "$*"; }
ok()   { printf '%s %s\n' "$(_c '1;32' ' ok')" "$*"; }
warn() { printf '%s %s\n' "$(_c '1;33' ' !!')" "$*" >&2; }
die()  { printf '%s %s\n' "$(_c '1;31' 'ERR')" "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1${2:+ ($2)}"
}

# Resolve the python that should run ComfyUI. Inside the NGC container this is
# the system python (which already carries the Blackwell-enabled torch build);
# we deliberately do NOT create a venv there, because a venv would shadow it.
comfy_python() {
  if [[ -n "${COMFY_PYTHON:-}" ]]; then
    echo "${COMFY_PYTHON}"
  elif [[ -x "${B200_WORKDIR}/venv/bin/python" ]]; then
    echo "${B200_WORKDIR}/venv/bin/python"
  else
    command -v python3
  fi
}

comfy_url() {
  local host="${COMFY_HOST}"
  [[ "${host}" == "0.0.0.0" ]] && host="127.0.0.1"
  echo "http://${host}:${COMFY_PORT}"
}

wait_for_comfy() {
  local timeout="${1:-300}" url elapsed=0
  url="$(comfy_url)"
  log "waiting for ComfyUI at ${url} (timeout ${timeout}s)"
  while (( elapsed < timeout )); do
    if curl -fsS --max-time 5 "${url}/system_stats" >/dev/null 2>&1; then
      ok "ComfyUI is up after ${elapsed}s"
      return 0
    fi
    sleep 3; elapsed=$((elapsed + 3))
  done
  die "ComfyUI did not become ready within ${timeout}s. Check: tmux attach -t ${TMUX_SERVER_SESSION}"
}
