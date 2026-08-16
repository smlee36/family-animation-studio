from __future__ import annotations

import json
import os
import runpy
import subprocess
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
    job_root = ROOT / "jobs" / job_id
    job = json.loads((job_root / "job.json").read_text(encoding="utf-8"))
    input_filenames = job.get("input_filenames") or [job["input_filename"]]
    if job.get("sequence_mode") == "montage":
        if len(input_filenames) != 3:
            raise ValueError("Montage mode requires exactly three ordered images")
        return len(input_filenames)
    return 1


def argv_for_job(job_id: str, offload_mode: str | None = None, segment_index: int = 0) -> list[str]:
    job_root = ROOT / "jobs" / job_id
    job = json.loads((job_root / "job.json").read_text(encoding="utf-8"))
    input_filenames = job.get("input_filenames") or [job["input_filename"]]
    montage = job.get("sequence_mode") == "montage"
    connected = len(input_filenames) > 1
    if not montage and segment_index != 0:
        raise ValueError("LTX jobs use one continuous timeline")
    preset = PRESETS[job["preset"]]
    preview = job.get("render_mode", "final") == "preview"
    if preview:
        width, height = (448, 768) if job["aspect_ratio"] == "9:16" else (768, 448)
    else:
        width, height = (576, 1024) if job["aspect_ratio"] == "9:16" else (1280, 704)
    segment_duration = 5 if montage else job["duration_seconds"]
    num_frames = segment_duration * 24 + 1
    output_path = job_root / (f"segment-{segment_index:02d}.mp4" if montage else "output.mp4")
    image_args = ["--image", str(job_root / input_filenames[0]), "0", "1.0"]
    if montage:
        image_args = ["--image", str(job_root / input_filenames[segment_index]), "0", "1.0"]
    elif connected:
        image_args = []
        last_frame = num_frames - 1
        intervals = len(input_filenames) - 1
        for index, input_filename in enumerate(input_filenames):
            frame_index = round(last_frame * index / intervals)
            strength = 1.0 if index in {0, intervals} else 0.45
            image_args.extend(["--image", str(job_root / input_filename), str(frame_index), str(strength)])
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
    job_root = ROOT / "jobs" / job_id
    job = json.loads((job_root / "job.json").read_text(encoding="utf-8"))
    if job.get("sequence_mode") != "montage":
        return

    inputs = [job_root / f"segment-{index:02d}.mp4" for index in range(3)]
    if any(not path.is_file() or path.stat().st_size == 0 for path in inputs):
        raise RuntimeError("A montage segment is missing")
    output_path = job_root / "output.mp4"
    filter_graph = (
        "[0:v]trim=0:4.2,setpts=PTS-STARTPTS,fps=24,format=yuv420p[v0];"
        "[1:v]trim=0:3.2,setpts=PTS-STARTPTS,fps=24,format=yuv420p[v1];"
        "[2:v]trim=0:3.2,setpts=PTS-STARTPTS,fps=24,format=yuv420p[v2];"
        "[v0][v1]xfade=transition=wipeleft:duration=0.30:offset=3.90[x1];"
        "[x1][v2]xfade=transition=wipeleft:duration=0.30:offset=6.80[v]"
    )
    command = [
        "/usr/bin/ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
        "-i", str(inputs[0]), "-i", str(inputs[1]), "-i", str(inputs[2]),
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-filter_complex", filter_graph, "-map", "[v]", "-map", "3:a",
        "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-t", "10.0", "-movflags", "+faststart",
        str(output_path),
    ]
    result = subprocess.run(command, check=False)
    if result.returncode != 0 or not output_path.is_file() or output_path.stat().st_size == 0:
        raise RuntimeError(f"FFmpeg montage failed with exit code {result.returncode}")


def main() -> None:
    job_id = sys.argv[1]
    os.chdir(LTX_ROOT)
    for segment_index in range(job_segment_count(job_id)):
        sys.argv = argv_for_job(job_id, segment_index=segment_index)
        runpy.run_module("ltx_pipelines.ti2vid_two_stages_hq", run_name="__main__")
    finalize_segments(job_id)


if __name__ == "__main__":
    main()
