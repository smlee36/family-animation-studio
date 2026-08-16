from __future__ import annotations

import json
import os
import socket
import sys
import traceback
from pathlib import Path

from run_job import LTX_ROOT, ROOT, argv_for_job


SOCKET_PATH = ROOT / ".resident.sock"


def receive_json(connection: socket.socket) -> dict:
    chunks: list[bytes] = []
    while True:
        chunk = connection.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
        if b"\n" in chunk:
            break
    return json.loads(b"".join(chunks).split(b"\n", 1)[0].decode("utf-8"))


def send_json(connection: socket.socket, payload: dict) -> None:
    connection.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))


def main() -> None:
    os.chdir(LTX_ROOT)
    from ltx_pipelines import ti2vid_two_stages_hq as pipeline_module

    original_pipeline = pipeline_module.TI2VidTwoStagesHQPipeline

    class ResidentPipelineFactory:
        instance = None

        def __new__(cls, *args, **kwargs):
            if cls.instance is None:
                print("[resident] loading LTX pipeline", flush=True)
                cls.instance = original_pipeline(*args, **kwargs)
                print("[resident] LTX pipeline ready", flush=True)
            return cls.instance

    pipeline_module.TI2VidTwoStagesHQPipeline = ResidentPipelineFactory
    if SOCKET_PATH.exists():
        SOCKET_PATH.unlink()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(SOCKET_PATH))
    SOCKET_PATH.chmod(0o600)
    server.listen(1)
    print(f"[resident] listening on {SOCKET_PATH}", flush=True)
    try:
        while True:
            connection, _ = server.accept()
            with connection:
                request = receive_json(connection)
                if request.get("command") == "shutdown":
                    send_json(connection, {"ok": True})
                    break
                job_id = str(request.get("job_id", ""))
                try:
                    sys.argv = argv_for_job(job_id, offload_mode="none")
                    pipeline_module.main()
                    send_json(connection, {"ok": True, "job_id": job_id})
                except Exception as error:
                    traceback.print_exc()
                    send_json(connection, {"ok": False, "job_id": job_id, "error": str(error)[-4000:]})
    finally:
        server.close()
        if SOCKET_PATH.exists():
            SOCKET_PATH.unlink()


if __name__ == "__main__":
    main()
