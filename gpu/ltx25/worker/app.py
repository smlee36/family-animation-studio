from __future__ import annotations

import hmac
import json
import os
import queue
import re
import shutil
import subprocess
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse


ROOT = Path(os.environ.get("LTX25_ROOT", "/NHNHOME/WORKSPACE/26mss002_U1A/ltx25"))
JOBS_ROOT = ROOT / "jobs"
LTX_ROOT = ROOT / "LTX-2"
PYTHON = LTX_ROOT / ".venv" / "bin" / "python"
RUNNER = ROOT / "project-config" / "worker" / "run_job.py"
TOKEN_FILE = Path(os.environ.get("LTX_API_TOKEN_FILE", str(ROOT / ".ltx_api_token")))
MAX_IMAGE_BYTES = 25 * 1024 * 1024
JOB_ID_PATTERN = re.compile(r"^[0-9a-f-]{36}$", re.IGNORECASE)

PRESETS = {
    "gentle": {"steps": 24, "cfg": 3.0, "stg": 0.5, "rescale": 0.55},
    "action": {"steps": 30, "cfg": 3.5, "stg": 1.0, "rescale": 0.70},
    "camera": {"steps": 30, "cfg": 3.0, "stg": 0.8, "rescale": 0.65},
}

app = FastAPI(title="Family Animation LTX-2.5 Worker", docs_url=None, redoc_url=None)
job_queue: queue.Queue[str] = queue.Queue()
worker_started = False
worker_lock = threading.Lock()


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def job_dir(job_id: str) -> Path:
    return JOBS_ROOT / job_id


def metadata_path(job_id: str) -> Path:
    return job_dir(job_id) / "job.json"


def load_job(job_id: str) -> dict:
    path = metadata_path(job_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Job not found")
    return json.loads(path.read_text(encoding="utf-8"))


def save_job(job: dict) -> None:
    path = metadata_path(job["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def require_token(authorization: str | None = Header(default=None)) -> None:
    expected = TOKEN_FILE.read_text(encoding="utf-8").strip() if TOKEN_FILE.is_file() else ""
    supplied = authorization.removeprefix("Bearer ").strip() if authorization and authorization.startswith("Bearer ") else ""
    if not expected or not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def command_for(job: dict) -> list[str]:
    return [str(PYTHON), str(RUNNER), job["id"]]


def error_tail(log_path: Path) -> str:
    if not log_path.is_file():
        return "LTX process failed without a log"
    text = log_path.read_text(encoding="utf-8", errors="replace")
    return text[-4000:]


def run_job(job_id: str) -> None:
    job = load_job(job_id)
    job.update(status="running", stage="LTX-2.5 모델 실행 중", started_at=now_iso(), updated_at=now_iso())
    save_job(job)
    log_path = job_dir(job_id) / "generation.log"
    try:
        with log_path.open("wb") as log_file:
            result = subprocess.run(
                command_for(job),
                cwd=LTX_ROOT,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                check=False,
            )
        output_path = job_dir(job_id) / "output.mp4"
        if result.returncode != 0 or not output_path.is_file() or output_path.stat().st_size == 0:
            raise RuntimeError(error_tail(log_path))
        job.update(
            status="succeeded",
            stage="완료",
            output_bytes=output_path.stat().st_size,
            completed_at=now_iso(),
            updated_at=now_iso(),
            error="",
        )
    except Exception as error:
        job.update(
            status="failed",
            stage="실패",
            completed_at=now_iso(),
            updated_at=now_iso(),
            error=str(error)[-4000:],
        )
    save_job(job)


def worker_loop() -> None:
    while True:
        job_id = job_queue.get()
        try:
            run_job(job_id)
        finally:
            job_queue.task_done()


def start_worker() -> None:
    global worker_started
    with worker_lock:
        if worker_started:
            return
        JOBS_ROOT.mkdir(parents=True, exist_ok=True)
        thread = threading.Thread(target=worker_loop, name="ltx25-worker", daemon=True)
        thread.start()
        worker_started = True
        for path in sorted(JOBS_ROOT.glob("*/job.json")):
            try:
                job = json.loads(path.read_text(encoding="utf-8"))
                if job.get("status") in {"queued", "running"}:
                    job.update(status="queued", stage="재시작 후 대기 중", updated_at=now_iso())
                    save_job(job)
                    job_queue.put(job["id"])
            except Exception:
                continue


@app.on_event("startup")
def on_startup() -> None:
    start_worker()


@app.get("/ltx/health", dependencies=[Depends(require_token)])
def health() -> dict:
    return {
        "ok": PYTHON.is_file() and TOKEN_FILE.is_file(),
        "model": "LTX-2.5 Dev BF16",
        "queue_depth": job_queue.qsize(),
    }


@app.post("/ltx/jobs", status_code=202, dependencies=[Depends(require_token)])
async def create_job(
    job_id: str = Form(...),
    prompt: str = Form(...),
    preset: Literal["gentle", "action", "camera"] = Form("gentle"),
    aspect_ratio: Literal["16:9", "9:16"] = Form("9:16"),
    duration_seconds: int = Form(6),
    seed: int = Form(42),
    image: UploadFile = File(...),
) -> dict:
    if not JOB_ID_PATTERN.fullmatch(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id")
    if not 10 <= len(prompt.strip()) <= 20_000:
        raise HTTPException(status_code=400, detail="Invalid prompt")
    if not 0 <= seed <= 2_147_483_647:
        raise HTTPException(status_code=400, detail="Invalid seed")
    if duration_seconds not in {4, 6, 8}:
        raise HTTPException(status_code=400, detail="Invalid duration")
    existing = metadata_path(job_id)
    if existing.is_file():
        return load_job(job_id)

    content_type = (image.content_type or "").lower()
    extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(content_type)
    if not extension:
        raise HTTPException(status_code=415, detail="Unsupported image type")
    destination_dir = job_dir(job_id)
    destination_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
    input_filename = f"input{extension}"
    destination = destination_dir / input_filename
    size = 0
    with destination.open("wb") as output:
        while chunk := await image.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_IMAGE_BYTES:
                shutil.rmtree(destination_dir, ignore_errors=True)
                raise HTTPException(status_code=413, detail="Image is too large")
            output.write(chunk)
    destination.chmod(0o600)
    if size == 0:
        shutil.rmtree(destination_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="Image is empty")

    timestamp = now_iso()
    job = {
        "id": job_id,
        "status": "queued",
        "stage": "B200 대기열에 등록됨",
        "prompt": prompt.strip(),
        "preset": preset,
        "aspect_ratio": aspect_ratio,
        "duration_seconds": duration_seconds,
        "seed": seed,
        "input_filename": input_filename,
        "input_bytes": size,
        "output_bytes": 0,
        "error": "",
        "created_at": timestamp,
        "updated_at": timestamp,
        "started_at": "",
        "completed_at": "",
    }
    save_job(job)
    job_queue.put(job_id)
    return job


@app.get("/ltx/jobs/{job_id}", dependencies=[Depends(require_token)])
def get_job(job_id: str) -> dict:
    if not JOB_ID_PATTERN.fullmatch(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id")
    return load_job(job_id)


@app.get("/ltx/jobs/{job_id}/video", dependencies=[Depends(require_token)])
def get_video(job_id: str) -> FileResponse:
    job = load_job(job_id)
    output_path = job_dir(job_id) / "output.mp4"
    if job.get("status") != "succeeded" or not output_path.is_file():
        raise HTTPException(status_code=409, detail="Video is not ready")
    return FileResponse(output_path, media_type="video/mp4", filename=f"{job_id}.mp4")
