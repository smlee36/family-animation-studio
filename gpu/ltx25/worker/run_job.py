from __future__ import annotations

import json
import os
import runpy
import sys
from pathlib import Path


ROOT = Path(os.environ.get("LTX25_ROOT", "/NHNHOME/WORKSPACE/26mss002_U1A/ltx25"))
MODEL_ROOT = ROOT / "models" / "ltx-2.5"
LTX_ROOT = ROOT / "LTX-2"
PRESETS = {
    "gentle": {"steps": 24, "cfg": 3.0, "stg": 0.5, "rescale": 0.55},
    "action": {"steps": 30, "cfg": 3.5, "stg": 1.0, "rescale": 0.70},
    "camera": {"steps": 30, "cfg": 3.0, "stg": 0.8, "rescale": 0.65},
}


def job_segment_count(job_id: str) -> int:
    # Three-photo stories are generated in one diffusion timeline. Running two
    # independent five-second jobs and concatenating them makes motion reset at
    # the middle keyframe, which is visible as a cut even when the boundary
    # frames themselves match.
    return 1


def argv_for_job(job_id: str, offload_mode: str | None = None, segment_index: int = 0) -> list[str]:
    job_root = ROOT / "jobs" / job_id
    job = json.loads((job_root / "job.json").read_text(encoding="utf-8"))
    input_filenames = job.get("input_filenames") or [job["input_filename"]]
    connected = len(input_filenames) == 3
    if segment_index != 0:
        raise ValueError("LTX jobs use one continuous timeline")
    preset = PRESETS[job["preset"]]
    preview = job.get("render_mode", "final") == "preview"
    if preview:
        width, height = (448, 768) if job["aspect_ratio"] == "9:16" else (768, 448)
    else:
        width, height = (576, 1024) if job["aspect_ratio"] == "9:16" else (1280, 704)
    num_frames = job["duration_seconds"] * 24 + 1
    output_path = job_root / "output.mp4"
    image_args = ["--image", str(job_root / input_filenames[0]), "0", "1.0"]
    if connected:
        image_args = [
            "--image", str(job_root / input_filenames[0]), "0", "1.0",
            "--image", str(job_root / input_filenames[1]), str((num_frames - 1) // 2), "1.0",
            "--image", str(job_root / input_filenames[2]), str(num_frames - 1), "1.0",
        ]
    return [
        "ltx_pipelines.ti2vid_two_stages_hq",
        "--transformer-path", str(MODEL_ROOT / "diffusion_models/ltx-2.5-22b-dev-transformer-bf16.safetensors"),
        "--text-encoder-path", str(MODEL_ROOT / "text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors"),
        "--video-vae-path", str(MODEL_ROOT / "vae/ltx-2.5-video-vae-bf16.safetensors"),
        "--audio-vae-path", str(MODEL_ROOT / "vae/ltx-2.5-audio-vae-bf16.safetensors"),
        "--distilled-lora", str(MODEL_ROOT / "loras/ltx-2.5-22b-distilled-lora-450-bf16.safetensors"), "1.0",
        "--spatial-upsampler-path", str(MODEL_ROOT / "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"),
        "--prompt", job["prompt"],
        "--output-path", str(output_path),
        *image_args,
        "--height", str(height), "--width", str(width),
        "--num-frames", str(num_frames),
        "--frame-rate", "24",
        "--num-inference-steps", str(8 if preview else preset["steps"]),
        "--video-cfg-guidance-scale", str(preset["cfg"]),
        "--video-stg-guidance-scale", str(preset["stg"]),
        "--video-rescale-scale", str(preset["rescale"]),
        "--offload", offload_mode or os.environ.get("LTX_OFFLOAD_MODE", "cpu"), "--max-batch-size", "1",
        "--seed", str(job["seed"]),
    ]


def finalize_segments(job_id: str) -> None:
    # Stable hook retained for the resident runner. Connected jobs now write
    # output.mp4 directly from one continuous generation.
    return


def main() -> None:
    job_id = sys.argv[1]
    os.chdir(LTX_ROOT)
    for segment_index in range(job_segment_count(job_id)):
        sys.argv = argv_for_job(job_id, segment_index=segment_index)
        runpy.run_module("ltx_pipelines.ti2vid_two_stages_hq", run_name="__main__")
    finalize_segments(job_id)


if __name__ == "__main__":
    main()
