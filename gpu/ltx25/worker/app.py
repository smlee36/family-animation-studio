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
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import Body, Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse


ROOT = Path(os.environ.get("LTX25_ROOT", "/NHNHOME/WORKSPACE/26mss002_U1A/ltx25"))
JOBS_ROOT = ROOT / "jobs"
MERGES_ROOT = ROOT / "merges"
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
MAX_MERGE_CLIP_BYTES = 250 * 1024 * 1024
MAX_MERGE_CLIPS = 100
JOB_ID_PATTERN = re.compile(r"^[0-9a-f-]{36}$", re.IGNORECASE)

PRESETS = {
    "gentle": {"steps": 24, "cfg": 3.0, "stg": 0.5, "rescale": 0.55},
    "action": {"steps": 30, "cfg": 3.5, "stg": 1.0, "rescale": 0.70},
    "camera": {"steps": 30, "cfg": 3.0, "stg": 0.8, "rescale": 0.65},
}

app = FastAPI(title="Family Animation LTX-2.5 Worker", docs_url=None, redoc_url=None)
job_queue: queue.Queue[str] = queue.Queue()
merge_queue: queue.Queue[str] = queue.Queue()
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


def merge_dir(merge_id: str) -> Path:
    return MERGES_ROOT / merge_id


def merge_metadata_path(merge_id: str) -> Path:
    return merge_dir(merge_id) / "merge.json"


def load_merge(merge_id: str) -> dict:
    path = merge_metadata_path(merge_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Merge job not found")
    return json.loads(path.read_text(encoding="utf-8"))


def save_merge(job: dict) -> None:
    path = merge_metadata_path(job["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, path)


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


def stop_standby_service() -> None:
    AX_PAUSE_FILE.touch(mode=0o600, exist_ok=True)
    subprocess.run(["pkill", "-f", "vllm.entrypoints.openai.api_server"], check=False)
    for _ in range(60):
        if not process_running("vllm.entrypoints.openai.api_server"):
            return
        time.sleep(1)
    raise RuntimeError("Qwen 235B service did not stop within 60 seconds")


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


def standby_healthy() -> bool:
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


def restore_standby_service() -> None:
    with batch_lock:
        state = load_batch_state()
        state.update(enabled=False, state="restoring", message="Qwen 235B 서비스를 복구하고 있어요.")
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
                if standby_healthy():
                    state.update(state="off", message="일반 모드 · Qwen 235B 정상 복구", error="")
                    save_batch_state(state)
                    return
                time.sleep(5)
            raise RuntimeError("Qwen 235B API did not become healthy within 15 minutes")
        except Exception as error:
            state.update(state="error", message="Qwen 235B 자동 복구를 확인해 주세요.", error=str(error)[-1000:])
        save_batch_state(state)


def parse_timestamp(value: str) -> float:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return time.time()


def expected_runtime_seconds(job: dict) -> int:
    if job.get("sequence_mode") == "montage":
        per_segment = 150 if job.get("render_mode") == "preview" else 432
        return per_segment * 2
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


def download_merge_clip(url: str, destination: Path) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".blob.vercel-storage.com"):
        raise RuntimeError("Merge clip URL is not an approved Vercel Blob URL")
    request = urllib.request.Request(url, headers={"User-Agent": "family-animation-studio-b200/1.0"})
    size = 0
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_MERGE_CLIP_BYTES:
                raise RuntimeError("A merge clip exceeds the 250MB limit")
            output.write(chunk)
    if size == 0:
        raise RuntimeError("A merge clip was empty")
    destination.chmod(0o600)


def clip_has_audio(path: Path) -> bool:
    result = subprocess.run(
        ["/usr/bin/ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
        text=True,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def normalize_merge_clip(source: Path, destination: Path, width: int, height: int, log_file) -> None:
    video_filter = f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24"
    audio_input = [] if clip_has_audio(source) else ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
    audio_map = ["-map", "0:v:0", "-map", "0:a:0?"] if not audio_input else ["-map", "0:v:0", "-map", "1:a:0", "-shortest"]
    common = [
        "/usr/bin/ffmpeg", "-y", "-hide_banner", "-i", str(source), *audio_input,
        *audio_map, "-vf", video_filter, "-af", "aresample=48000", "-ar", "48000", "-ac", "2",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
    ]
    hardware = subprocess.run(
        [*common, "-c:v", "h264_nvenc", "-preset", "p4", "-cq", "20", "-pix_fmt", "yuv420p", str(destination)],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if hardware.returncode == 0 and destination.is_file() and destination.stat().st_size:
        return
    destination.unlink(missing_ok=True)
    software = subprocess.run(
        [*common, "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", str(destination)],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if software.returncode != 0 or not destination.is_file() or destination.stat().st_size == 0:
        raise RuntimeError("FFmpeg could not normalize a merge clip")


def run_merge(merge_id: str) -> None:
    job = load_merge(merge_id)
    job.update(status="running", stage="승인 영상을 내려받는 중", started_at=now_iso(), updated_at=now_iso())
    save_merge(job)
    directory = merge_dir(merge_id)
    log_path = directory / "merge.log"
    try:
        width, height = (1920, 1080) if job["aspect_ratio"] == "16:9" else (1080, 1920)
        normalized_paths: list[Path] = []
        with log_path.open("wb") as log_file:
            for index, clip in enumerate(job["clips"]):
                job.update(stage=f"영상 준비 중 {index + 1}/{len(job['clips'])}", updated_at=now_iso())
                save_merge(job)
                source = directory / f"source-{index:03d}.mp4"
                normalized = directory / f"normalized-{index:03d}.mp4"
                download_merge_clip(clip["url"], source)
                normalize_merge_clip(source, normalized, width, height, log_file)
                source.unlink(missing_ok=True)
                normalized_paths.append(normalized)

            concat_path = directory / "concat.txt"
            concat_path.write_text("".join(f"file '{path.name}'\n" for path in normalized_paths), encoding="utf-8")
            concat_path.chmod(0o600)
            job.update(stage="최종 MP4로 합치는 중", updated_at=now_iso())
            save_merge(job)
            output_path = directory / "output.mp4"
            result = subprocess.run(
                ["/usr/bin/ffmpeg", "-y", "-hide_banner", "-f", "concat", "-safe", "0", "-i", str(concat_path), "-c", "copy", "-movflags", "+faststart", str(output_path)],
                cwd=directory,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                check=False,
            )
        if result.returncode != 0 or not output_path.is_file() or output_path.stat().st_size == 0:
            raise RuntimeError(error_tail(log_path))
        probe = subprocess.run(
            ["/usr/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(output_path)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False,
        )
        duration_seconds = round(float(probe.stdout.strip()), 3) if probe.returncode == 0 and probe.stdout.strip() else 0
        job.update(status="succeeded", stage="완료", output_bytes=output_path.stat().st_size, duration_seconds=duration_seconds, completed_at=now_iso(), updated_at=now_iso(), error="")
    except Exception as error:
        job.update(status="failed", stage="최종 영상 병합 실패", completed_at=now_iso(), updated_at=now_iso(), error=str(error)[-4000:])
    save_merge(job)


def merge_worker_loop() -> None:
    while True:
        merge_id = merge_queue.get()
        try:
            run_merge(merge_id)
        finally:
            merge_queue.task_done()


def batch_idle_monitor() -> None:
    while True:
        time.sleep(30)
        state = load_batch_state()
        if not state["enabled"] or state["state"] != "ready" or active_jobs():
            continue
        last_job_at = parse_timestamp(state["last_job_at"] or state["enabled_at"])
        if time.time() - last_job_at >= int(state["idle_restore_seconds"]):
            restore_standby_service()


def start_worker() -> None:
    global worker_started
    with worker_lock:
        if worker_started:
            return
        JOBS_ROOT.mkdir(parents=True, exist_ok=True)
        MERGES_ROOT.mkdir(parents=True, exist_ok=True)
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
        threading.Thread(target=merge_worker_loop, name="ltx25-merge-worker", daemon=True).start()
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
        for path in sorted(MERGES_ROOT.glob("*/merge.json")):
            try:
                merge_job = json.loads(path.read_text(encoding="utf-8"))
                if merge_job.get("status") in {"queued", "running"}:
                    merge_job.update(status="queued", stage="재시작 후 병합 대기 중", updated_at=now_iso())
                    save_merge(merge_job)
                    merge_queue.put(merge_job["id"])
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
            state.update(enabled=True, state="starting", message="Qwen 235B를 멈추고 LTX 전용 GPU를 준비하고 있어요.", enabled_at=timestamp, last_job_at=timestamp, error="")
            save_batch_state(state)
            try:
                stop_standby_service()
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
    threading.Thread(target=restore_standby_service, name="ltx25-qwen235-restore", daemon=True).start()
    return {**batch_status(), "enabled": False, "state": "restoring", "message": "Qwen 235B 서비스를 복구하고 있어요."}


@app.post("/ltx/jobs", status_code=202, dependencies=[Depends(require_token)])
async def create_job(
    job_id: str = Form(...),
    prompt: str = Form(...),
    preset: Literal["gentle", "action", "camera"] = Form("gentle"),
    aspect_ratio: Literal["16:9", "9:16"] = Form("9:16"),
    duration_seconds: int = Form(5),
    render_mode: Literal["preview", "final"] = Form("preview"),
    sequence_mode: Literal["timeline", "montage"] = Form("timeline"),
    end_frame_strength: float = Form(1.0),
    seed: int = Form(42),
    image: UploadFile = File(...),
    keyframe_images: list[UploadFile] | None = File(default=None),
) -> dict:
    if not JOB_ID_PATTERN.fullmatch(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id")
    if not 10 <= len(prompt.strip()) <= 20_000:
        raise HTTPException(status_code=400, detail="Invalid prompt")
    if not 0 <= seed <= 2_147_483_647:
        raise HTTPException(status_code=400, detail="Invalid seed")
    if duration_seconds not in {5, 10}:
        raise HTTPException(status_code=400, detail="Invalid duration")
    if not 0.1 <= end_frame_strength <= 1.0:
        raise HTTPException(status_code=400, detail="Invalid end frame strength")
    existing = metadata_path(job_id)
    if existing.is_file():
        return job_with_progress(load_job(job_id))

    uploads = [image, *(keyframe_images or [])]
    if not 1 <= len(uploads) <= 9:
        raise HTTPException(status_code=400, detail="A video accepts between one and nine ordered keyframes")
    destination_dir = job_dir(job_id)
    destination_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
    input_filenames: list[str] = []
    input_bytes = 0
    for index, upload in enumerate(uploads):
        content_type = (upload.content_type or "").lower()
        extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(content_type)
        if not extension:
            shutil.rmtree(destination_dir, ignore_errors=True)
            raise HTTPException(status_code=415, detail="Unsupported image type")
        input_filename = f"input-{index:02d}{extension}"
        destination = destination_dir / input_filename
        size = 0
        with destination.open("wb") as output:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_IMAGE_BYTES:
                    shutil.rmtree(destination_dir, ignore_errors=True)
                    raise HTTPException(status_code=413, detail="Image is too large")
                output.write(chunk)
        destination.chmod(0o600)
        if size == 0:
            shutil.rmtree(destination_dir, ignore_errors=True)
            raise HTTPException(status_code=400, detail="Image is empty")
        input_filenames.append(input_filename)
        input_bytes += size

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
        "sequence_mode": sequence_mode,
        "end_frame_strength": end_frame_strength,
        "seed": seed,
        "input_filename": input_filenames[0],
        "input_filenames": input_filenames,
        "input_bytes": input_bytes,
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


@app.post("/ltx/merges", status_code=202, dependencies=[Depends(require_token)])
def create_merge(payload: dict = Body(...)) -> dict:
    merge_id = str(payload.get("merge_id") or "")
    clips = payload.get("clips")
    aspect_ratio = payload.get("aspect_ratio")
    transition = payload.get("transition")
    if not JOB_ID_PATTERN.fullmatch(merge_id):
        raise HTTPException(status_code=400, detail="Invalid merge id")
    if not isinstance(clips, list) or not 1 <= len(clips) <= MAX_MERGE_CLIPS:
        raise HTTPException(status_code=400, detail="A merge requires between 1 and 100 clips")
    if aspect_ratio not in {"16:9", "9:16"} or transition != "hard_cut":
        raise HTTPException(status_code=400, detail="Invalid merge format")
    normalized_clips = []
    for clip in clips:
        if not isinstance(clip, dict) or not isinstance(clip.get("url"), str) or not isinstance(clip.get("generation_id"), str):
            raise HTTPException(status_code=400, detail="Invalid merge clip")
        parsed = urllib.parse.urlparse(clip["url"])
        if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".blob.vercel-storage.com"):
            raise HTTPException(status_code=400, detail="Invalid merge clip URL")
        normalized_clips.append({"url": clip["url"], "generation_id": clip["generation_id"]})
    existing = merge_metadata_path(merge_id)
    if existing.is_file():
        return load_merge(merge_id)
    directory = merge_dir(merge_id)
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    timestamp = now_iso()
    job = {
        "id": merge_id,
        "status": "queued",
        "stage": "최종 영상 병합 대기 중",
        "clips": normalized_clips,
        "aspect_ratio": aspect_ratio,
        "transition": transition,
        "output_bytes": 0,
        "duration_seconds": 0,
        "error": "",
        "created_at": timestamp,
        "updated_at": timestamp,
        "started_at": "",
        "completed_at": "",
    }
    save_merge(job)
    merge_queue.put(merge_id)
    return job


@app.get("/ltx/merges/{merge_id}", dependencies=[Depends(require_token)])
def get_merge(merge_id: str) -> dict:
    if not JOB_ID_PATTERN.fullmatch(merge_id):
        raise HTTPException(status_code=400, detail="Invalid merge id")
    return load_merge(merge_id)


@app.get("/ltx/merges/{merge_id}/video", dependencies=[Depends(require_token)])
def get_merged_video(merge_id: str) -> FileResponse:
    job = load_merge(merge_id)
    output_path = merge_dir(merge_id) / "output.mp4"
    if job.get("status") != "succeeded" or not output_path.is_file():
        raise HTTPException(status_code=409, detail="Merged video is not ready")
    return FileResponse(output_path, media_type="video/mp4", filename=f"family-episode-{merge_id}.mp4")
