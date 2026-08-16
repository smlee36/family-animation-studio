"""A small fake ComfyUI server.

It implements enough of the real HTTP API for the batch pipeline and the doctor
to be exercised end to end without a GPU: /system_stats, /object_info,
/upload/image, /prompt, /history, /view and /interrupt. It deliberately does NOT
serve a websocket, which also makes it a test of the client's polling fallback.

Run standalone for manual poking:

    python -m tests.mock_comfyui --port 8199
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# A minimal but structurally faithful /object_info. Enum inputs use ComfyUI's
# [[choices], {opts}] encoding so the doctor's enum checking is really tested.
CHECKPOINTS = ["ltx/ltxv.safetensors", "wan/wan2.2_i2v_a14b.safetensors"]
CLIPS = ["t5xxl.safetensors", "umt5_xxl.safetensors"]
VAES = ["wan/wan_2.1_vae.safetensors"]
UPSCALERS = ["RealESRGAN_x4.pth"]
RIFE = ["rife47.pth"]
SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m", "uni_pc"]
SCHEDULERS = ["normal", "simple", "karras"]
CLIP_VISION = ["clip_vision_h.safetensors"]

FLOAT = ["FLOAT", {"default": 1.0}]
INT = ["INT", {"default": 1}]
BOOL = ["BOOLEAN", {"default": True}]
STR = ["STRING", {"multiline": True}]


def _node(required: dict[str, object], optional: dict[str, object] | None = None) -> dict:
    return {"input": {"required": required, "optional": optional or {}}}


OBJECT_INFO: dict[str, dict] = {
    "CheckpointLoaderSimple": _node({"ckpt_name": [CHECKPOINTS, {}]}),
    "UNETLoader": _node({"unet_name": [CHECKPOINTS, {}], "weight_dtype": [["default", "fp8_e4m3fn"], {}]}),
    "CLIPLoader": _node({"clip_name": [CLIPS, {}], "type": [["ltxv", "wan", "sd3"], {}]}),
    "VAELoader": _node({"vae_name": [VAES, {}]}),
    "CLIPVisionLoader": _node({"clip_name": [CLIP_VISION, {}]}),
    "CLIPVisionEncode": _node({"clip_vision": ["CLIP_VISION"], "image": ["IMAGE"], "crop": [["center", "none"], {}]}),
    "CLIPTextEncode": _node({"text": STR, "clip": ["CLIP"]}),
    "LoadImage": _node({"image": [["placeholder.png"], {"image_upload": True}], "upload": [["image"], {}]}),
    "LTXVImgToVideo": _node({
        "positive": ["CONDITIONING"], "negative": ["CONDITIONING"], "vae": ["VAE"], "image": ["IMAGE"],
        "width": INT, "height": INT, "length": INT, "batch_size": INT,
    }),
    "EmptyLTXVLatentVideo": _node({"width": INT, "height": INT, "length": INT, "batch_size": INT}),
    "LTXVAddGuide": _node({
        "positive": ["CONDITIONING"], "negative": ["CONDITIONING"], "vae": ["VAE"],
        "latent": ["LATENT"], "image": ["IMAGE"], "frame_idx": INT, "strength": FLOAT,
    }),
    "LTXVCropGuides": _node({"positive": ["CONDITIONING"], "negative": ["CONDITIONING"], "latent": ["LATENT"]}),
    "LTXVConditioning": _node({"positive": ["CONDITIONING"], "negative": ["CONDITIONING"], "frame_rate": FLOAT}),
    "LTXVScheduler": _node(
        {"steps": INT, "max_shift": FLOAT, "base_shift": FLOAT, "stretch": BOOL, "terminal": FLOAT},
        {"latent": ["LATENT"]},
    ),
    "KSamplerSelect": _node({"sampler_name": [SAMPLERS, {}]}),
    "SamplerCustom": _node({
        "model": ["MODEL"], "add_noise": BOOL, "noise_seed": INT, "cfg": FLOAT,
        "positive": ["CONDITIONING"], "negative": ["CONDITIONING"],
        "sampler": ["SAMPLER"], "sigmas": ["SIGMAS"], "latent_image": ["LATENT"],
    }),
    "KSampler": _node({
        "model": ["MODEL"], "seed": INT, "steps": INT, "cfg": FLOAT,
        "sampler_name": [SAMPLERS, {}], "scheduler": [SCHEDULERS, {}],
        "positive": ["CONDITIONING"], "negative": ["CONDITIONING"],
        "latent_image": ["LATENT"], "denoise": FLOAT,
    }),
    "ModelSamplingSD3": _node({"model": ["MODEL"], "shift": FLOAT}),
    "WanImageToVideo": _node({
        "positive": ["CONDITIONING"], "negative": ["CONDITIONING"], "vae": ["VAE"],
        "width": INT, "height": INT, "length": INT, "batch_size": INT,
    }, {"clip_vision_output": ["CLIP_VISION_OUTPUT"], "start_image": ["IMAGE"]}),
    "VAEDecode": _node({"samples": ["LATENT"], "vae": ["VAE"]}),
    "UpscaleModelLoader": _node({"model_name": [UPSCALERS, {}]}),
    "ImageUpscaleWithModel": _node({"upscale_model": ["UPSCALE_MODEL"], "image": ["IMAGE"]}),
    "ImageScale": _node({
        "image": ["IMAGE"], "upscale_method": [["nearest-exact", "bilinear", "lanczos"], {}],
        "width": INT, "height": INT, "crop": [["disabled", "center"], {}],
    }),
    "RIFE VFI": _node({
        "ckpt_name": [RIFE, {}], "frames": ["IMAGE"], "clear_cache_after_n_frames": INT,
        "multiplier": INT, "fast_mode": BOOL, "ensemble": BOOL, "scale_factor": FLOAT,
    }),
    "VHS_VideoCombine": _node({
        "images": ["IMAGE"], "frame_rate": FLOAT, "loop_count": INT,
        "filename_prefix": ["STRING", {"default": "out"}],
        "format": [["video/h264-mp4", "image/gif"], {}],
        "pix_fmt": [["yuv420p", "yuv444p"], {}], "crf": INT,
        "save_metadata": BOOL, "pingpong": BOOL, "save_output": BOOL,
    }),
}


class _Part:
    __slots__ = ("name", "filename", "data")

    def __init__(self, name: str, filename: str | None, data: bytes):
        self.name = name
        self.filename = filename
        self.data = data


def _parse_multipart(content_type: str, body: bytes) -> dict[str, _Part]:
    """Parse multipart/form-data. Enough for what the client actually sends.

    Written by hand because `cgi` was removed in Python 3.13 and never exposed
    the per-part filename, which is exactly what an upload endpoint needs.
    """
    marker = "boundary="
    if marker not in content_type:
        raise ValueError("no boundary in Content-Type")
    boundary = content_type.split(marker, 1)[1].split(";")[0].strip().strip('"')
    sep = b"--" + boundary.encode()

    parts: dict[str, _Part] = {}
    for chunk in body.split(sep):
        if chunk in (b"", b"--", b"--\r\n", b"\r\n"):
            continue
        chunk = chunk.lstrip(b"\r\n")
        if chunk.startswith(b"--"):
            break
        head, _, data = chunk.partition(b"\r\n\r\n")
        if not _:
            continue
        data = data[:-2] if data.endswith(b"\r\n") else data

        name: str | None = None
        filename: str | None = None
        for line in head.decode("utf-8", "replace").split("\r\n"):
            if not line.lower().startswith("content-disposition:"):
                continue
            for param in line.split(";")[1:]:
                key, _eq, value = param.strip().partition("=")
                value = value.strip().strip('"')
                if key == "name":
                    name = value
                elif key == "filename":
                    filename = value
        if name:
            parts[name] = _Part(name, filename, data)
    return parts


class MockState:
    """Server-side state, and the knobs tests use to force failure paths."""

    def __init__(self, root: str):
        self.root = root
        self.input_dir = os.path.join(root, "input")
        self.output_dir = os.path.join(root, "output")
        os.makedirs(self.input_dir, exist_ok=True)
        os.makedirs(self.output_dir, exist_ok=True)

        self.history: dict[str, dict] = {}
        self.prompts: list[dict] = []
        self.uploads: list[str] = []

        self.exec_delay = 0.0
        # fail_times[n] > 0 makes the next n /prompt executions fail, so the
        # retry logic can be tested deterministically.
        self.fail_times = 0
        self.reject_next = False        # simulate a 400 validation error
        self.produce_output = True      # simulate "finished but wrote nothing"
        self.lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    state: MockState

    def log_message(self, fmt, *a):  # noqa: ANN001, ARG002 — silence test noise
        pass

    # ------------------------------------------------------------------ utils
    def _send_json(self, obj: object, code: int = 200) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -------------------------------------------------------------------- GET
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)

        if path == "/system_stats":
            return self._send_json({
                "system": {"os": "linux", "comfyui_version": "mock"},
                "devices": [{
                    "name": "NVIDIA B200 (mock)", "type": "cuda", "index": 0,
                    "vram_total": 193273528320, "vram_free": 150323855360,
                }],
            })

        if path == "/object_info":
            return self._send_json(OBJECT_INFO)

        if path.startswith("/object_info/"):
            cls = path.split("/", 2)[2]
            if cls in OBJECT_INFO:
                return self._send_json({cls: OBJECT_INFO[cls]})
            return self._send_json({}, 404)

        if path.startswith("/history"):
            parts = path.strip("/").split("/")
            with self.state.lock:
                if len(parts) == 2:
                    entry = self.state.history.get(parts[1])
                    return self._send_json({parts[1]: entry} if entry else {})
                return self._send_json(dict(self.state.history))

        if path == "/view":
            filename = (query.get("filename") or [""])[0]
            subfolder = (query.get("subfolder") or [""])[0]
            full = os.path.join(self.state.output_dir, subfolder, filename)
            if not os.path.exists(full):
                return self._send_json({"error": "not found"}, 404)
            data = open(full, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if path == "/queue":
            return self._send_json({"queue_running": [], "queue_pending": []})

        self._send_json({"error": f"no route {path}"}, 404)

    # ------------------------------------------------------------------- POST
    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path

        if path == "/interrupt":
            return self._send_json({})

        if path == "/upload/image":
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                return self._send_json({"error": "expected multipart"}, 400)
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            try:
                parts = _parse_multipart(content_type, body)
            except ValueError as exc:
                return self._send_json({"error": str(exc)}, 400)

            image_part = parts.get("image")
            if image_part is None:
                return self._send_json({"error": "no 'image' field"}, 400)
            data = image_part.data
            name = image_part.filename or f"upload_{len(self.state.uploads)}.png"

            subfolder_part = parts.get("subfolder")
            subfolder = subfolder_part.data.decode() if subfolder_part else "b200"

            target_dir = os.path.join(self.state.input_dir, subfolder)
            os.makedirs(target_dir, exist_ok=True)
            with open(os.path.join(target_dir, name), "wb") as fh:
                fh.write(data)
            with self.state.lock:
                self.state.uploads.append(f"{subfolder}/{name}")
            return self._send_json({"name": name, "subfolder": subfolder, "type": "input"})

        if path == "/prompt":
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
            graph = payload.get("prompt") or {}

            if self.state.reject_next:
                self.state.reject_next = False
                return self._send_json({
                    "error": {"type": "prompt_outputs_failed_validation", "message": "Prompt outputs failed validation"},
                    "node_errors": {"1": {"class_type": "CheckpointLoaderSimple", "errors": [
                        {"message": "Value not in list", "details": "ckpt_name: 'nope.safetensors' not in list"}]}},
                }, 400)

            unknown = sorted({n.get("class_type") for n in graph.values()} - set(OBJECT_INFO))
            if unknown:
                return self._send_json({
                    "error": {"type": "invalid_prompt", "message": f"unknown node class: {', '.join(unknown)}"},
                    "node_errors": {},
                }, 400)

            prompt_id = str(uuid.uuid4())
            with self.state.lock:
                self.state.prompts.append({"prompt_id": prompt_id, "graph": graph})
            threading.Thread(target=self._execute, args=(prompt_id, graph), daemon=True).start()
            return self._send_json({"prompt_id": prompt_id, "number": len(self.state.prompts), "node_errors": {}})

        self._send_json({"error": f"no route {path}"}, 404)

    # -------------------------------------------------------------- execution
    def _execute(self, prompt_id: str, graph: dict) -> None:
        time.sleep(self.state.exec_delay)

        with self.state.lock:
            should_fail = self.state.fail_times > 0
            if should_fail:
                self.state.fail_times -= 1

        if should_fail:
            with self.state.lock:
                self.state.history[prompt_id] = {
                    "prompt": [0, prompt_id, graph],
                    "outputs": {},
                    "status": {
                        "status_str": "error", "completed": False,
                        "messages": [["execution_error", {
                            "node_id": "10", "node_type": "SamplerCustom",
                            "exception_message": "mock: CUDA out of memory",
                        }]],
                    },
                }
            return

        outputs: dict[str, dict] = {}
        if self.state.produce_output:
            out_node = next(
                (nid for nid, n in graph.items() if n.get("class_type") == "VHS_VideoCombine"),
                None,
            )
            if out_node is not None:
                prefix = graph[out_node]["inputs"].get("filename_prefix", "out")
                subfolder = os.path.dirname(prefix) or ""
                stem = os.path.basename(prefix) or "out"
                target_dir = os.path.join(self.state.output_dir, subfolder)
                os.makedirs(target_dir, exist_ok=True)
                filename = f"{stem}_00001.mp4"
                with open(os.path.join(target_dir, filename), "wb") as fh:
                    # Not a real mp4; just a deterministic, non-empty payload the
                    # test can assert on after download.
                    fh.write(b"\x00\x00\x00\x18ftypmp42MOCKCLIP" + prompt_id.encode())
                outputs[out_node] = {"gifs": [{
                    "filename": filename, "subfolder": subfolder,
                    "type": "output", "format": "video/h264-mp4",
                }]}

        with self.state.lock:
            self.state.history[prompt_id] = {
                "prompt": [0, prompt_id, graph],
                "outputs": outputs,
                "status": {"status_str": "success", "completed": True, "messages": []},
            }


class MockComfyServer:
    """Context manager that runs the mock on a free port in a background thread."""

    def __init__(self, root: str | None = None, port: int = 0):
        self.root = root or tempfile.mkdtemp(prefix="mock-comfy-")
        self.state = MockState(self.root)
        handler = type("BoundHandler", (Handler,), {"state": self.state})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def __enter__(self) -> "MockComfyServer":
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8199)
    ap.add_argument("--root", default="")
    args = ap.parse_args()
    with MockComfyServer(root=args.root or None, port=args.port) as server:
        print(f"mock ComfyUI on {server.url} (state in {server.root})")
        print("Ctrl-C to stop")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
