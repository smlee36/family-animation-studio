from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import torch
from diffusers import QwenImageEditPlusPipeline
from PIL import Image, ImageOps


ROOT = Path(os.environ.get("QWEN_IMAGE_ROOT", "/NHNHOME/WORKSPACE/26mss002_U1A/qwen-image"))
MODEL = ROOT / "models" / "Qwen-Image-Edit-2511"


def main() -> None:
    job_id = sys.argv[1]
    directory = ROOT / "jobs" / job_id
    job = json.loads((directory / "job.json").read_text(encoding="utf-8"))
    references = [Image.open(directory / name).convert("RGB") for name in job["reference_filenames"]]
    width, height = (1664, 928) if job["aspect_ratio"] == "16:9" else (928, 1664)
    pipeline = QwenImageEditPlusPipeline.from_pretrained(str(MODEL), torch_dtype=torch.bfloat16)
    pipeline.to("cuda")
    pipeline.set_progress_bar_config(disable=False)
    generator = torch.Generator(device="cuda").manual_seed(int(job["seed"]))
    with torch.inference_mode():
        result = pipeline(
            image=references,
            prompt=job["prompt"],
            generator=generator,
            true_cfg_scale=4.0,
            negative_prompt="photorealistic, live action, 3D render, duplicate people, extra limbs, distorted hands, text, captions, watermark",
            num_inference_steps=40,
            guidance_scale=1.0,
            num_images_per_prompt=1,
        ).images[0]
    output = ImageOps.fit(result.convert("RGB"), (width, height), method=Image.Resampling.LANCZOS)
    output.save(directory / "output.jpg", quality=94, optimize=True)
    del pipeline
    torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
