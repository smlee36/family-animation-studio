# LTX-2.5 B200 notes

## Phase 1 validation

- Host: managed NVIDIA B200 node (183,359 MiB VRAM), Ubuntu 24.04.3, NVIDIA driver 580.95.05.
- Runtime: isolated Python environment with PyTorch 2.13.0+cu132 and NATTEN 0.21.7.
- Model: official Lightricks LTX-2.5 Dev BF16 checkpoints and distilled LoRA.
- Generation: official `ltx_pipelines.ti2vid_two_stages_hq` image-to-video pipeline.
- Input: 1280x720 family illustration.
- Output: 1280x704, 121 frames, 24 fps, 5.04 seconds, H.264/AAC MP4.
- Wall time: 277 seconds (4 minutes 37 seconds).
- Peak GPU allocation observed: 115,598 MiB total. The resident A.X service used about 95,308 MiB, so the incremental peak attributable to the offloaded LTX run was about 20.3 GiB.
- Output on B200: `/NHNHOME/WORKSPACE/26mss002_U1A/ltx25/outputs/phase1_family_bear_1280x704_5s.mp4`.
- Logs: `/NHNHOME/WORKSPACE/26mss002_U1A/ltx25/logs/phase1-i2v.log` and `phase1-vram.csv`.

The start, middle, and end frames preserve the child, large teddy bear, living-room layout, and illustration style. Motion is intentionally subtle (breathing and smiling), with a small camera push-in. This is a passing baseline for a calm scene, not yet the final motion-quality preset.

## Family Animation Studio integration validation

- The authenticated public worker route accepted a real family illustration and completed a queued job through the Cloudflare Tunnel.
- Output: H.264/AAC MP4, 1280x704, 97 frames, 24 fps, 4.04 seconds, 524,917 bytes.
- End-to-end worker time including model loading: about 6 minutes.
- Visual review of start, middle, and end frames confirmed stable 2D style, child identity, large teddy-bear proportions, and living-room layout.
- The production Vercel application reports `LTX-2.5 Dev BF16` reachable and uses LTX as the default video provider. Google generation remains an explicit fallback.
- Worker jobs, prompts, inputs, and logs are stored with owner-only permissions. The model prompt is loaded from the private job file by `run_job.py`, so it is not exposed in the operating-system process command line.
- A one-minute keepalive cron restarts the worker if its private localhost health check fails. The durable job record lets queued or running work resume after a worker restart.

## Fast preview and resident batch validation

- Validation date: 2026-08-17, B200 production worker, 4-second 9:16 gentle-motion input.
- Normal coexistence mode (A.X resident, LTX CPU offload): preview completed in 318 seconds.
- LTX-dedicated resident mode, first preview including initial model load: 60 seconds.
- LTX-dedicated resident mode, second preview with the pipeline already resident: 55 seconds.
- All three outputs were non-empty H.264/AAC MP4 files and durable job records reached `succeeded`.
- The batch-mode exit test stopped the resident runner, relaunched A.X, waited for its authenticated
  `/v1/models` response, and confirmed served model id `x`. GPU memory returned to the prior A.X
  operating level (about 95.9 GiB used).
- Because the resident path requires A.X to release GPU memory, it is opt-in, rejects mode changes
  while jobs are active, and automatically restores A.X after ten idle minutes.

## Compatibility decisions

The GPU host is a managed container and does not expose Docker or sudo, so a nested NGC container cannot be launched from this session. The official LTX-2 repository is instead installed in an isolated virtual environment on the managed CUDA host. This keeps dependencies separate while using the host's Blackwell-compatible driver/runtime.

Flash Attention 4 is not installed. The official pipeline selected PyTorch SDPA automatically. This is compatible with the B200 and completed successfully, but full-attention execution may be slower than an optimized Flash Attention kernel.

ComfyUI-LTXVideo currently imports a helper removed from Kornia 0.8.3. The isolated runtime pins Kornia 0.8.2, which restores the import. After the pin, the custom package registered 81 LTX nodes and a CUDA matrix-multiplication smoke test still passed. The pin also resolved `nvidia-cudnn-cu13` to 9.20.0.48, so this combination must be retained and retested when either package is upgraded.

## ComfyUI access

ComfyUI is kept private on the GPU node. Open a local tunnel before browsing:

```bash
ssh -N -L 8188:127.0.0.1:8188 technode-b200
```

Then open `http://127.0.0.1:8188`.

Server status:

```bash
ssh technode-b200 'tmux list-sessions | grep ltx25-comfy'
ssh technode-b200 'curl -fsS http://127.0.0.1:8188/system_stats'
```
