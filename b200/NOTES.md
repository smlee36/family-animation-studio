# NOTES — decisions, trade-offs, and what is still unverified

## Read this first: what was and was not verified

This subtree was authored in a Claude Code cloud sandbox that had **no GPU, no
Docker daemon, 30 GB of disk, and an egress policy that blocked
`huggingface.co`** (the proxy answered `403` to `CONNECT huggingface.co:443`).
Nothing that requires a Blackwell GPU or the Hugging Face Hub could be executed.

| Area | State |
| --- | --- |
| Batch pipeline logic (discovery, bindings, retries, versioning, reports) | **Verified** — 91 tests against a mock ComfyUI server |
| Preset inheritance and validation | **Verified** by tests |
| Workflow doctor (detects wrong node class / input / model filename) | **Verified** by tests |
| Sweep tool | **Verified** by tests |
| Shell scripts | Syntax-checked only (`bash -n`); never executed against real hardware |
| Dockerfile / compose | Never built |
| LTX-2.5 Hugging Face repo id | **Unverified — resolved at runtime, see below** |
| ComfyUI node class names in `workflows/*.json` | **Unverified — validate with the doctor, see below** |
| Preset parameter values | Reasoned starting points, **not measured** on real keyframes |
| Generation time / VRAM figures | **Not measured** — nothing has run on a B200 |

The design response to that constraint was to make every unverifiable fact
*discovered at runtime* rather than hardcoded, and to make the discovery tools
part of the deliverable. The three below are the ones that matter.

### 1. Model repo ids are resolved, not assumed

`config/models.yaml` lists **candidate** repo ids. `scripts/20_fetch_models.sh`
probes each candidate against the HF API, falls back to discovering repos under
the configured org by regex, prints the real remote file tree with sizes, and
only then downloads. `--list` stops after the tree.

```bash
scripts/20_fetch_models.sh --model ltx --list
```

If the resolved repo is not the one you want, correct
`families.ltx.candidates` in `config/models.yaml` — that is the only place a
model id appears.

### 2. Node class names are validated, not assumed

The graphs in `workflows/` are written against the LTXV / Wan ComfyUI node sets.
Node classes get renamed between model generations, and **LTX-2.5 may well not
use the same node names as the LTX-Video 0.9.x graphs these were modelled on.**
Rather than guess silently, `pipeline/doctor.py` diffs every graph against the
server's live `/object_info` and names the fix:

```bash
python -m pipeline.doctor --url http://127.0.0.1:8188
python -m pipeline.doctor --list-nodes ltx --verbose   # what this install really has
```

It reports three classes of problem, each with a suggested replacement:
a node class the server does not have, a bound input name that does not exist,
and a literal value (checkpoint filename, sampler name) that is not in the
server's dropdown. `scripts/40_smoke_test.sh` runs it as a gate before the first
generation. Expect to fix a few names on the first run; that is the intended
workflow, not a failure.

Because parameters are bound by node **title** (`B200::prompt`) rather than node
id, you can rewire a graph in the ComfyUI editor and the pipeline keeps working
as long as the titles survive. If a node class changes, edit the graph JSON; if
an input name changes, edit `workflows/index.yaml`.

### 3. Presets are starting points with a tool to finish them

`config/presets.yaml` ships `calm` / `action` / `camera` (plus `draft` and
`final_1080p`). The values encode how the LTX knobs behave — mainly that
`max_shift`/`base_shift` is the real motion dial and that high `cfg` pushes an
illustration toward photoreal — but they were **not** measured on your
watercolour keyframes. `scripts/50_sweep.sh` runs a parameter grid on one
keyframe with the seed held fixed and writes an `index.md` for side-by-side
review. Copy the winning row back into `presets.yaml`.

---

## Blackwell (sm_100) specifics

### CUDA / PyTorch floor

sm_100 codegen requires **CUDA 12.8+** and a driver from the **570 branch or
newer**. A torch wheel built without sm_100 does not fail cleanly on a B200 — it
either PTX-JITs (very slow first run) or dies with *"no kernel image is
available for execution on the device"*, sometimes only deep into sampling.

Two guards exist because of this:

- `scripts/00_preflight.sh` checks the driver branch, the toolkit version, and
  crucially that `sm_100` appears in `torch.cuda.get_arch_list()` — then proves
  it with a real bf16 matmul on the device rather than trusting metadata.
- `scripts/10_install_comfyui.sh` freezes the container's torch/torchvision/
  torchaudio into a pip constraints file **before** installing ComfyUI's
  requirements, so no transitive dependency can quietly replace the
  Blackwell-capable build with a generic PyPI wheel. It re-verifies afterwards.

That second one is the failure this project is most likely to hit: ComfyUI
custom nodes routinely pull `torch` and it is silent when it downgrades you.

### Attention backend: SDPA by default

`scripts/30_serve_comfyui.sh` passes `--use-pytorch-cross-attention`, forcing
PyTorch SDPA.

**Trade-off.** flash-attention and xformers frequently lag on Blackwell wheels;
installing one built only for sm_90 produces either a build failure or, worse, a
runtime kernel error partway through a long generation. SDPA is slower than a
tuned flash-attn kernel — expect a modest throughput cost on long video
sequences — but it ships with torch, is guaranteed to have sm_100 kernels in a
CUDA 12.8+ build, and is numerically fine.

If a Blackwell flash-attn build is available on your box, set
`COMFY_ATTENTION=auto` in `b200/.env` and let ComfyUI choose. Benchmark before
keeping it: `scripts/40_smoke_test.sh` reports wall time, so run it both ways.

`scripts/10_install_comfyui.sh` deliberately does **not** treat a failed
kernel-package install as fatal — it warns and continues, because SDPA is a
working fallback.

### `--highvram`

180 GB of HBM3e is enough to keep the whole model resident, so the server starts
with `--highvram` to avoid per-step offload. Override with `COMFY_EXTRA_ARGS`.

---

## Other decisions worth knowing

**Why 704 and not 720.** LTX's latent grid needs both dimensions divisible by
32, and 720/32 = 22.5. The usable "720p" is **1280×704**. The preset validator
enforces this — it caught the mistake in the first draft of `presets.yaml`.
The post workflow delivers a true 1920×1080 by upscaling and resizing after
decode, where the constraint no longer applies.

**Why frame counts are (8k)+1.** LTX compresses temporally by 8. A length that
is not `8k+1` gets silently truncated by the VAE and the clip comes out shorter
than asked. `presets.py` rejects it up front and names the nearest valid value.

**Why the muxer fps is scaled.** In `ltx_i2v_firstlast_post`, RIFE doubles the
frame count. If the muxer still runs at the generation fps the clip plays in
slow motion, so `frame_rate` binds to the output node with
`scale_by: interpolate_multiplier`.

**Why `/history` is authoritative.** The websocket is used for progress only.
A dropped socket must never be mistaken for a finished job, so completion and
success are always confirmed against `/history`. If `websocket-client` is not
installed the client silently falls back to polling — the mock server has no
websocket endpoint, which means the polling path is what the test suite
exercises.

**Why binding by title.** Node ids are unstable across editor round-trips.
Titles (`B200::prompt`) survive, and `index_titles()` refuses duplicates so a
copy-pasted node cannot silently capture a binding.

**Why outputs are versioned, never overwritten.** Regenerating writes `_v2`,
`_v3`. Losing a good take to a worse re-roll is not recoverable, and disk is
cheaper than a re-render.

**Why a scene failure does not stop the run.** The overnight requirement. Each
scene retries with backoff, then is recorded and skipped. The process exit code
is non-zero if anything failed, and `clips/_reports/run-*.md` lists each failure
with its error. `--stop-on-error` opts out.

**Why the ComfyUI port is bound to loopback.** ComfyUI has no authentication.
`docker-compose.yml` publishes on `127.0.0.1` by default; use
`ssh -N -L 8188:127.0.0.1:8188 user@b200-host`. `COMFY_BIND=0.0.0.0` overrides
that deliberately.

---

## Known gaps

- **No real-hardware run.** Every number in `presets.yaml` and every node name
  in `workflows/` needs one pass on the B200 to confirm. The doctor and the
  sweep exist to make that pass short.
- **Wan 2.2 A14B is a MoE with high-noise/low-noise experts.** `wan_i2v.json`
  wires a single `UNETLoader`. If the release ships separate expert checkpoints,
  that graph needs a second loader and a sampler split — the doctor will flag
  the missing pieces but cannot rewire the graph for you.
- **No automatic quality scoring.** The sweep produces clips and a table; you
  judge them. The main app already has a GPT-based QC step (Phase 5 of the web
  app) that could be pointed at these clips later.
- **`cgi`-free multipart parser in the mock** is minimal — it handles what
  `requests` sends, not the full RFC.
