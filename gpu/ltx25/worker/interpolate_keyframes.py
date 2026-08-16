from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps
from safetensors.torch import load_file


DEFAULT_COMFY_ROOT = Path("/NHNHOME/WORKSPACE/26mss002_U1A/ltx25/ComfyUI")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Interpolate ordered family-animation keyframes with FILM.")
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--comfy-root", type=Path, default=DEFAULT_COMFY_ROOT)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=704)
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--duration", type=float, default=10.0)
    return parser.parse_args()


def load_image(path: Path, width: int, height: int, device: torch.device) -> torch.Tensor:
    with Image.open(path) as source:
        image = ImageOps.fit(source.convert("RGB"), (width, height), method=Image.Resampling.LANCZOS)
    array = np.asarray(image, dtype=np.float32) / 255.0
    return torch.from_numpy(array).permute(2, 0, 1).unsqueeze(0).to(device=device, dtype=torch.float16)


def write_frame(process: subprocess.Popen, frame: torch.Tensor) -> None:
    if process.stdin is None:
        raise RuntimeError("FFmpeg stdin is unavailable")
    array = frame.squeeze(0).permute(1, 2, 0).clamp(0, 1).mul(255).byte().cpu().numpy()
    process.stdin.write(array.tobytes())


def main() -> None:
    args = parse_args()
    if len(args.images) < 2:
        raise ValueError("At least two ordered keyframes are required")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU is required")
    for path in [*args.images, args.model]:
        if not path.is_file():
            raise FileNotFoundError(path)

    sys.path.insert(0, str(args.comfy_root))
    from comfy_extras.frame_interpolation_models.film_net import FILMNet

    device = torch.device("cuda")
    model = FILMNet()
    model.load_state_dict(load_file(args.model))
    model.eval().to(device=device, dtype=torch.float16)

    total_frames = round(args.duration * args.fps) + 1
    intervals = len(args.images) - 1
    interval_steps = [
        round((total_frames - 1) * (index + 1) / intervals) - round((total_frames - 1) * index / intervals)
        for index in range(intervals)
    ]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = subprocess.Popen(
        [
            "/usr/bin/ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s:v", f"{args.width}x{args.height}",
            "-r", str(args.fps), "-i", "pipe:0",
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart",
            str(args.output),
        ],
        stdin=subprocess.PIPE,
    )

    try:
        previous = load_image(args.images[0], args.width, args.height, device)
        write_frame(ffmpeg, previous)
        with torch.inference_mode():
            for index, steps in enumerate(interval_steps):
                following = load_image(args.images[index + 1], args.width, args.height, device)
                timesteps = [step / steps for step in range(1, steps)]
                if timesteps:
                    interpolated = model.forward_multi_timestep(previous, following, timesteps)
                    for frame in interpolated:
                        write_frame(ffmpeg, frame.unsqueeze(0))
                    del interpolated
                write_frame(ffmpeg, following)
                previous = following
                torch.cuda.empty_cache()
    finally:
        if ffmpeg.stdin:
            ffmpeg.stdin.close()
        return_code = ffmpeg.wait()
    if return_code != 0 or not args.output.is_file():
        raise RuntimeError(f"FFmpeg failed with exit code {return_code}")
    print(args.output)


if __name__ == "__main__":
    main()
