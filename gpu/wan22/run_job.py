from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(os.environ.get("WAN22_ROOT", "/NHNHOME/WORKSPACE/26mss002_U1A/wan22"))
REPOSITORY = ROOT / "Wan2.2"
WORKSPACE_MODEL = ROOT / "models" / "Wan2.2-I2V-A14B"
LOCAL_MODEL = Path(os.environ.get("WAN22_LOCAL_MODEL", "/NHNHOME/.family-animation-models/Wan2.2-I2V-A14B"))
MODEL = LOCAL_MODEL if (LOCAL_MODEL / ".ready").is_file() else WORKSPACE_MODEL
PYTHON = ROOT / ".venv" / "bin" / "python"


def main() -> None:
    job_id = sys.argv[1]
    directory = ROOT / "jobs" / job_id
    job = json.loads((directory / "job.json").read_text(encoding="utf-8"))
    # Wan 2.2 writes at its native 16 fps. Frame counts must be 4n+1, so
    # 5 seconds = 81 frames and 10 seconds = 161 frames.
    frame_count = int(job["duration_seconds"]) * 16 + 1
    command = [
        str(PYTHON), str(REPOSITORY / "generate.py"),
        "--task", "i2v-A14B",
        "--size", "1280*720",
        "--ckpt_dir", str(MODEL),
        "--offload_model", "False",
        "--convert_model_dtype",
        "--image", str(directory / job["input_filename"]),
        "--prompt", job["prompt"],
        "--frame_num", str(frame_count),
        "--sample_steps", str(int(job.get("sample_steps", 20))),
        "--base_seed", str(job["seed"]),
        "--save_file", str(directory / "output.mp4"),
    ]
    raise SystemExit(subprocess.run(command, cwd=REPOSITORY, check=False).returncode)


if __name__ == "__main__":
    main()
