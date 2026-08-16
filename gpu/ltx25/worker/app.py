from __future__ import annotations

import hmac
import json
import os
import queue
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import Body, Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse


ROOT = Path(os.environ.get("LTX25_ROOT", "/NHNHOME/WORKSPACE/26mss002_U1A/ltx25"))
JOBS_ROOT = ROOT / "jobs"
LTX_ROOT = ROOT / "LTX-2"
PYTHON = LTX_ROOT / ".venv" / "bin" / "python"
RUNNER = ROOT / "project-config" / "worker" / "run_job.py"
RESIDENT_RUNNER = ROOT / "project-config" / "worker" / "resident_runner.py"
RESIDENT_SOCKET = ROOT / ".resident.sock"
BATCH_STATE_PATH = ROOT / "batch-mode.json"
AX_ROOT = ROOT.parent
AX_PAUSE_FILE = AX_ROOT / "PAUSE_WATCHDOG"
AX_SERVE_SCRIPT = AX_ROOT / "serve_current.sh"
AX_TOKEN_FILE = AX_ROOT / ".tn_token"
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
batch_lock = threading.Lock()
resident_process: subprocess.Popen | None = None


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


def default_batch_state() -> dict:
    return {"enabled": False, "state": "off", "message": "일반 모드", "enabled_at": "", "last_job_at": "", "idle_restore_seconds": 600, "error": ""}


def load_batch_state() -> dict:
    if not BATCH_STATE_PATH.is_file():
        return default_batch_state()
    try:
        return {**default_batch_state(), **json.loads(BATCH_STATE_PATH.read_text(encoding="utf-8"))}
    except Exception:
        return default_batch_state()


def save_batch_state(state: dict) -> None:
    temporary = BATCH_STATE_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, BATCH_STATE_PATH)


def process_running(pattern: str) -> bool:
    for command_path in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            arguments = [item.decode("utf-8", errors="ignore") for item in command_path.read_bytes().split(b"\0") if item]
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        if pattern in arguments or any(argument.endswith(f"/{pattern}") for argument in arguments):
            return True
    return False


def batch_status() -> dict:
    state = load_batch_state()
    return {
        "enabled": bool(state["enabled"]),
        "state": state["state"],
        "residentReady": RESIDENT_SOCKET.exists() and process_running("resident_runner.py"),
        "axRunning": process_running("vllm.entrypoints.openai.api_server"),
        "idleRestoreSeconds": int(state["idle_restore_seconds"]),
        "message": state["message"],
    }


def stop_ax_service() -> None:
    AX_PAUSE_FILE.touch(mode=0o600, exist_ok=True)
    subprocess.run(["pkill", "-f", "vllm.entrypoints.openai.api_server"], check=False)
    for _ in range(60):
        if not process_running("vllm.entrypoints.openai.api_server"):
            return
        time.sleep(1)
    raise RuntimeError("A.X service did not stop within 60 seconds")


def start_resident_runner() -> None:
    global resident_process
    if RESIDENT_SOCKET.exists() and process_running("resident_runner.py"):
        return
    subprocess.run(["pkill", "-f", "resident_runner.py"], check=False)
    RESIDENT_SOCKET.unlink(missing_ok=True)
    log_path = ROOT / "logs" / "resident-runner.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("ab") as log_file:
        resident_process = subprocess.Popen([str(PYTHON), str(RESIDENT_RUNNER)], cwd=LTX_ROOT, stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(60):
        if RESIDENT_SOCKET.exists():
            return
        if resident_process.poll() is not None:
            raise RuntimeError("LTX resident runner stopped during startup")
        time.sleep(1)
    raise RuntimeError("LTX resident runner socket was not ready")


def resident_request(payload: dict, timeout: int = 3600) -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(str(RESIDENT_SOCKET))
        connection.sendall((json.dumps(payload) + "\n").encode("utf-8"))
        chunks: list[bytes] = []
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            if b"\n" in chunk:
                break
    return json.loads(b"".join(chunks).split(b"\n", 1)[0].decode("utf-8"))


def stop_resident_runner() -> None:
    global resident_process
    if RESIDENT_SOCKET.exists():
        try:
            resident_request({"command": "shutdown"}, timeout=30)
        except Exception:
            pass
    if resident_process and resident_process.poll() is None:
        try:
            resident_process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            resident_process.terminate()
    subprocess.run(["pkill", "-f", "resident_runner.py"], check=False)
    RESIDENT_SOCKET.unlink(missing_ok=True)
    resident_process = None


def ax_healthy() -> bool:
    if not process_running("vllm.entrypoints.openai.api_server"):
        return False
    token = AX_TOKEN_FILE.read_text(encoding="utf-8").strip() if AX_TOKEN_FILE.is_file() else ""
    request = urllib.request.Request("http://127.0.0.1:8000/v1/models")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError):
        return False


def restore_ax_service() -> None:
    with batch_lock:
        state = load_batch_state()
        state.update(enabled=False, state="restoring", message="A.X 서비스를 복구하고 있어요.")
        save_batch_state(state)
        try:
            stop_resident_runner()
            if not process_running("vllm.entrypoints.openai.api_server"):
                log_path = AX_ROOT / "logs" / "vllm_batch_restore.log"
                log_path.parent.mkdir(parents=True, exist_ok=True)
                with log_path.open("ab") as log_file:
                    subprocess.Popen([str(AX_SERVE_SCRIPT)], cwd=AX_ROOT, stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True)
            AX_PAUSE_FILE.unlink(missing_ok=True)
            for _ in range(180):
                if ax_healthy():
                    state.update(state="off", message="일반 모드 · A.X 정상 복구", error="")
                    save_batch_state(state)
                    return
                time.sleep(5)
            raise RuntimeError("A.X API did not become healthy within 15 minutes")
        except Exception as error:
            state.update(state="error", message="A.X 자동 복구를 확인해 주세요.", error=str(error)[-1000:])
        save_batch_state(state)


def parse_timestamp(value: str) -> float:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return time.time()


def expected_runtime_seconds(job: dict) -> int:
    if job.get("render_mode") == "preview":
        if int(job.get("duration_seconds", 5)) >= 10:
            return 240 if job.get("preset") == "gentle" else 300
        return 120 if job.get("preset") == "gentle" else 150
    base = {4: 360, 5: 360, 6: 450, 8: 570, 10: 720}.get(int(job.get("duration_seconds", 5)), 360)
    if job.get("preset") in {"action", "camera"}:
        base = round(base * 1.2)
    return base


def active_jobs() -> list[dict]:
    jobs: list[dict] = []
    for path in JOBS_ROOT.glob("*/job.json"):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
            if job.get("status") in {"queued", "running"}:
                jobs.append(job)
        except Exception:
            continue
    return sorted(jobs, key=lambda item: item.get("created_at", ""))


def job_with_progress(job: dict) -> dict:
    result = dict(job)
    if job.get("status") not in {"queued", "running"}:
        result.update(queue_position=0, estimated_seconds_remaining=0)
        return result

    active = active_jobs()
    current_index = next((index for index, item in enumerate(active) if item.get("id") == job.get("id")), 0)
    seconds_remaining = 0
    for index, item in enumerate(active[:current_index + 1]):
        estimate = expected_runtime_seconds(item)
        if item.get("status") == "running":
            elapsed = max(0, round(time.time() - parse_timestamp(item.get("started_at", ""))))
            estimate = max(30, estimate - elapsed)
        seconds_remaining += estimate
    result.update(
        queue_position=current_index if job.get("status") == "queued" else 0,
        estimated_seconds_remaining=seconds_remaining,
    )
    return result


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
    use_resident = load_batch_state()["enabled"] and RESIDENT_SOCKET.exists()
    stage = "LTX 상시 모델로 빠르게 실행 중" if use_resident else "LTX-2.5 모델 실행 중"
    job.update(status="running", stage=stage, started_at=now_iso(), updated_at=now_iso())
    save_job(job)
    log_path = job_dir(job_id) / "generation.log"
    try:
        if use_resident:
            result_payload = resident_request({"job_id": job_id})
            if not result_payload.get("ok"):
                raise RuntimeError(result_payload.get("error") or "Resident LTX generation failed")
            result_code = 0
        else:
            with log_path.open("wb") as log_file:
                result = subprocess.run(
                    command_for(job),
                    cwd=LTX_ROOT,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    check=False,
                )
            result_code = result.returncode
        output_path = job_dir(job_id) / "output.mp4"
        if result_code != 0 or not output_path.is_file() or output_path.stat().st_size == 0:
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


def batch_idle_monitor() -> None:
    while True:
        time.sleep(30)
        state = load_batch_state()
        if not state["enabled"] or state["state"] != "ready" or active_jobs():
            continue
        last_job_at = parse_timestamp(state["last_job_at"] or state["enabled_at"])
        if time.time() - last_job_at >= int(state["idle_restore_seconds"]):
            restore_ax_service()


def start_worker() -> None:
    global worker_started
    with worker_lock:
        if worker_started:
            return
        JOBS_ROOT.mkdir(parents=True, exist_ok=True)
        state = load_batch_state()
        if state["enabled"]:
            try:
                start_resident_runner()
                state.update(state="ready", message="고속 배치 모드 · LTX 전용 GPU 준비 완료")
            except Exception as error:
                state.update(enabled=False, state="error", message="LTX 상시 모델을 복구하지 못했습니다.", error=str(error)[-1000:])
            save_batch_state(state)
        thread = threading.Thread(target=worker_loop, name="ltx25-worker", daemon=True)
        thread.start()
        threading.Thread(target=batch_idle_monitor, name="ltx25-batch-monitor", daemon=True).start()
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
        "batch_mode": batch_status(),
    }


@app.post("/ltx/batch-mode", dependencies=[Depends(require_token)])
def set_batch_mode(payload: dict = Body(...)) -> dict:
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        raise HTTPException(status_code=400, detail="enabled must be a boolean")
    if active_jobs():
        raise HTTPException(status_code=409, detail="현재 영상 작업이 끝난 뒤 배치 모드를 전환해 주세요.")
    if enabled:
        with batch_lock:
            state = load_batch_state()
            if state["enabled"] and state["state"] == "ready":
                state["last_job_at"] = now_iso()
                save_batch_state(state)
                return batch_status()
            timestamp = now_iso()
            state.update(enabled=True, state="starting", message="A.X를 멈추고 LTX 전용 GPU를 준비하고 있어요.", enabled_at=timestamp, last_job_at=timestamp, error="")
            save_batch_state(state)
            try:
                stop_ax_service()
                start_resident_runner()
                state.update(state="ready", message="고속 배치 모드 · LTX 전용 GPU 준비 완료")
                save_batch_state(state)
            except Exception as error:
                state.update(enabled=False, state="error", message="고속 배치 모드를 준비하지 못했습니다.", error=str(error)[-1000:])
                save_batch_state(state)
                AX_PAUSE_FILE.unlink(missing_ok=True)
                if not process_running("vllm.entrypoints.openai.api_server"):
                    log_path = AX_ROOT / "logs" / "vllm_batch_restore.log"
                    log_path.parent.mkdir(parents=True, exist_ok=True)
                    with log_path.open("ab") as log_file:
                        subprocess.Popen([str(AX_SERVE_SCRIPT)], cwd=AX_ROOT, stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True)
                raise HTTPException(status_code=500, detail=state["message"]) from error
        return batch_status()
    threading.Thread(target=restore_ax_service, name="ltx25-ax-restore", daemon=True).start()
    return {**batch_status(), "enabled": False, "state": "restoring", "message": "A.X 서비스를 복구하고 있어요."}


@app.post("/ltx/jobs", status_code=202, dependencies=[Depends(require_token)])
async def create_job(
    job_id: str = Form(...),
    prompt: str = Form(...),
    preset: Literal["gentle", "action", "camera"] = Form("gentle"),
    aspect_ratio: Literal["16:9", "9:16"] = Form("9:16"),
    duration_seconds: int = Form(5),
    render_mode: Literal["preview", "final"] = Form("preview"),
    seed: int = Form(42),
    image: UploadFile = File(...),
) -> dict:
    if not JOB_ID_PATTERN.fullmatch(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id")
    if not 10 <= len(prompt.strip()) <= 20_000:
        raise HTTPException(status_code=400, detail="Invalid prompt")
    if not 0 <= seed <= 2_147_483_647:
        raise HTTPException(status_code=400, detail="Invalid seed")
    if duration_seconds not in {5, 10}:
        raise HTTPException(status_code=400, detail="Invalid duration")
    existing = metadata_path(job_id)
    if existing.is_file():
        return job_with_progress(load_job(job_id))

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
        "render_mode": render_mode,
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
    state = load_batch_state()
    if state["enabled"]:
        state["last_job_at"] = timestamp
        save_batch_state(state)
    job_queue.put(job_id)
    return job_with_progress(job)


@app.get("/ltx/jobs/{job_id}", dependencies=[Depends(require_token)])
def get_job(job_id: str) -> dict:
    if not JOB_ID_PATTERN.fullmatch(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id")
    return job_with_progress(load_job(job_id))


@app.get("/ltx/jobs/{job_id}/video", dependencies=[Depends(require_token)])
def get_video(job_id: str) -> FileResponse:
    job = load_job(job_id)
    output_path = job_dir(job_id) / "output.mp4"
    if job.get("status") != "succeeded" or not output_path.is_file():
        raise HTTPException(status_code=409, detail="Video is not ready")
    return FileResponse(output_path, media_type="video/mp4", filename=f"{job_id}.mp4")
