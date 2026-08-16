# B200 + LTX self-hosted video generation

Self-hosted image-to-video on an NVIDIA B200, as an alternative to the cloud Veo
path the main web app uses. Keyframe images in, video clips out, either through
the ComfyUI GUI or a one-command overnight batch run.

> **Status: authored but not yet run on hardware.** The Python pipeline is
> covered by 91 tests against a mock ComfyUI server; the GPU-dependent parts
> have never executed, because this was written in a sandbox with no GPU and no
> access to `huggingface.co`. Model repo ids and ComfyUI node names are
> therefore *resolved and validated at runtime* instead of hardcoded — see
> [NOTES.md](NOTES.md), which lists exactly what is verified and what is not.
> Read it before the first run.

## Layout

```
b200/
  scripts/       00_preflight → 10_install → 20_fetch → 30_serve → 40_smoke → 50_sweep
  docker/        NGC PyTorch base image + compose with GPU passthrough
  config/        models.yaml (weight sources), presets.yaml (scene presets), custom_nodes.txt
  workflows/     API-format ComfyUI graphs + index.yaml binding table
  pipeline/      the Python package (batch runner, client, doctor, sweep)
  tests/         mock ComfyUI server + the test suite
  keyframes/     your input images (gitignored)
  clips/         generated output (gitignored)
```

## First run, in order

Everything below assumes you are on the B200 host.

```bash
cd b200
cp .env.example .env          # set HF_TOKEN, and B200_WORKDIR if models live elsewhere

# 0. Does this machine actually support sm_100? Fails loudly if not.
./scripts/00_preflight.sh --require-gpu

# 1. Build and enter the container (skip if running on the host directly)
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml exec comfy bash

# 2. ComfyUI + custom nodes (protects the container's Blackwell torch build)
./scripts/10_install_comfyui.sh

# 3. Weights. Look before you leap:
./scripts/20_fetch_models.sh --model ltx --list    # resolve + print the file tree
./scripts/20_fetch_models.sh --model ltx           # download in tmux

# 4. Start the server
./scripts/30_serve_comfyui.sh

# 5. Prove it end to end
./scripts/40_smoke_test.sh
```

### Watching the long-running jobs

| what | session | commands |
| --- | --- | --- |
| weight download | `ltx-download` | `tmux attach -t ltx-download` · `tail -f .work/logs/fetch-*.log` · `watch -n30 du -sh .work/models` |
| ComfyUI server | `comfyui` | `tmux attach -t comfyui` · `tail -f .work/logs/comfyui-latest.log` |
| parameter sweep | `ltx-sweep` | `tmux attach -t ltx-sweep` |

Detach from any of them with `Ctrl-b` then `d`. `tmux has-session -t <name>`
tells you whether it is still running.

### Browser access

ComfyUI listens on port **8188**. It has **no authentication**, so compose
publishes it on `127.0.0.1` only. Reach the GUI over an SSH tunnel:

```bash
ssh -N -L 8188:127.0.0.1:8188 <user>@<b200-host>
# then open http://127.0.0.1:8188
```

Set `COMFY_BIND=0.0.0.0` in `.env` only if you deliberately want it on the LAN.

## When the first generation fails

It probably will, and the likely cause is a node class or model filename that
differs on your install. The doctor tells you which:

```bash
python -m pipeline.doctor --url http://127.0.0.1:8188
python -m pipeline.doctor --list-nodes ltx --verbose    # what this install really exposes
```

It reports missing node classes, wrong input names and model filenames the
server does not have — each with the closest real alternative. Fix node classes
in `workflows/*.json`, input names in `workflows/index.yaml`, then re-run.

## Batch generation

Put keyframes in `keyframes/` following the naming rules in
[keyframes/README.md](keyframes/README.md):

```
scene01_start.png  scene01_end.png  scene01_prompt.txt  [scene01_preset.txt]
```

Then:

```bash
python -m pipeline.batch_generate                       # everything, preset "calm"
python -m pipeline.batch_generate --preset action
python -m pipeline.batch_generate --scenes scene01,scene04
python -m pipeline.batch_generate --dry-run             # resolve everything, generate nothing
python -m pipeline.batch_generate --model wan           # Phase 4 model swap
python -m pipeline.batch_generate --compare ltx,wan     # both, into clips/<model>/
```

Outputs land in `clips/scene01_v1.mp4`; regenerating writes `_v2`, never
overwriting. A run report (JSON + Markdown) goes to `clips/_reports/`.

Useful flags for unattended runs: `--retries 2`, `--reseed-on-retry`,
`--skip-existing`, `--timeout 3600`. A scene that fails is retried, recorded and
stepped over — the run always reaches the end. `Ctrl-C` once finishes the
current scene and stops cleanly; twice aborts.

## Presets

| preset | for | notes |
| --- | --- | --- |
| `calm` | breathing, blinking, drifting hair — static camera | lowest motion; use this when clips shimmer |
| `action` | walking, turning, gesturing | higher shift, eased end guide so the last second doesn't snap |
| `camera` | pans, push-ins, parallax | the hard case; low cfg so the model can invent edge content |
| `draft` | iteration | ~1/3 the cost, 960×544, 3s |
| `final_1080p` | delivery | first+last → 4× upscale → 1080p → 2× interpolation to 48fps |
| `wan_calm`, `wan_action` | Phase 4 comparison | Wan 2.2 equivalents |

`--preset X` sets the default; a `scene01_preset.txt` sidecar overrides it per
scene. With `--model wan`, `--preset calm` resolves to `wan_calm` automatically.

These values are reasoned starting points, **not measured on your artwork**.
Tune them with a sweep:

```bash
./scripts/50_sweep.sh --image keyframes/scene01_start.png \
    --axis steps=20,30,40 --axis cfg=2.5,3.0,3.5
```

The seed is held fixed across the grid, so differences come only from the axes.
Review `sweeps/<timestamp>/index.md` and copy the winning row into
`config/presets.yaml`.

## Tests

```bash
cd b200 && python -m pytest tests/ -q
```

91 tests, no GPU required — they run the whole pipeline against a mock ComfyUI
server, including the retry, versioning, fallback and reporting paths.

## Next steps

1. Run `00_preflight.sh --require-gpu` on the B200 and fix anything it reports.
2. Resolve the real LTX-2.5 repo with `20_fetch_models.sh --model ltx --list`
   and correct `config/models.yaml` if the candidate list missed.
3. Run the doctor and fix the node names it flags.
4. Get `40_smoke_test.sh` green; record its time/VRAM numbers here.
5. Sweep on two or three real watercolour keyframes and finalise the presets.
6. Batch-run three scenes to confirm the Phase 3 path end to end.
7. Optional: install Wan 2.2 and produce the `--compare ltx,wan` set.
