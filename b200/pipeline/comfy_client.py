"""Minimal, dependency-light client for the ComfyUI HTTP + WebSocket API.

Covers exactly what the batch pipeline needs:
  GET  /system_stats          health + VRAM reporting
  GET  /object_info           node schema, used to validate workflows up front
  POST /upload/image          push keyframes into ComfyUI's input dir
  POST /prompt                enqueue an API-format graph
  WS   /ws                    live progress
  GET  /history/{prompt_id}   outputs after completion
  GET  /view                  download a produced file
  POST /interrupt             cancel the running job

The websocket is used for progress only. Completion is always confirmed against
/history, because a dropped socket must not be mistaken for a finished job.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Iterable

import requests


class ComfyError(RuntimeError):
    """Any failure talking to ComfyUI."""


class ExecutionError(ComfyError):
    """The graph was accepted but failed during execution."""

    def __init__(self, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.details = details or {}


class ExecutionTimeout(ComfyError):
    pass


@dataclass
class Progress:
    """A progress tick, passed to the caller's callback."""

    prompt_id: str
    node: str | None
    node_title: str | None
    value: int
    max_value: int
    stage: str  # "queued" | "executing" | "sampling" | "done"

    @property
    def fraction(self) -> float:
        return (self.value / self.max_value) if self.max_value else 0.0


@dataclass
class OutputFile:
    filename: str
    subfolder: str
    type: str
    node_id: str
    kind: str  # "images" | "gifs" | "videos" | "audio" | ...


class ComfyClient:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8188",
        client_id: str | None = None,
        timeout: int = 30,
        session: requests.Session | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.client_id = client_id or str(uuid.uuid4())
        self.timeout = timeout
        self.http = session or requests.Session()

    # ------------------------------------------------------------------ basics
    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _get(self, path: str, **kw: Any) -> requests.Response:
        try:
            resp = self.http.get(self._url(path), timeout=self.timeout, **kw)
        except requests.RequestException as exc:
            raise ComfyError(f"GET {path} failed: {exc}") from exc
        if not resp.ok:
            raise ComfyError(f"GET {path} -> {resp.status_code}: {resp.text[:400]}")
        return resp

    def ping(self) -> bool:
        try:
            self._get("/system_stats")
            return True
        except ComfyError:
            return False

    def wait_until_ready(self, timeout: int = 300, interval: float = 3.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.ping():
                return
            time.sleep(interval)
        raise ComfyError(f"ComfyUI at {self.base_url} not ready after {timeout}s")

    def system_stats(self) -> dict[str, Any]:
        return self._get("/system_stats").json()

    def vram_summary(self) -> str:
        """Human-readable VRAM line for logs and the run report."""
        try:
            stats = self.system_stats()
        except ComfyError as exc:
            return f"(vram unavailable: {exc})"
        parts = []
        for dev in stats.get("devices", []):
            total = dev.get("vram_total", 0) / 1024**3
            free = dev.get("vram_free", 0) / 1024**3
            parts.append(f"{dev.get('name', '?')}: {total - free:.1f}/{total:.1f} GiB used")
        return "; ".join(parts) or "(no devices reported)"

    def object_info(self, node_class: str | None = None) -> dict[str, Any]:
        path = f"/object_info/{urllib.parse.quote(node_class)}" if node_class else "/object_info"
        return self._get(path).json()

    def available_nodes(self) -> set[str]:
        return set(self.object_info().keys())

    # ------------------------------------------------------------------ inputs
    def upload_image(
        self,
        path: str,
        subfolder: str = "b200",
        overwrite: bool = True,
        image_type: str = "input",
    ) -> str:
        """Upload a local image; returns the reference LoadImage expects."""
        with open(path, "rb") as fh:
            files = {"image": (path.rsplit("/", 1)[-1], fh, "application/octet-stream")}
            data = {
                "overwrite": "true" if overwrite else "false",
                "subfolder": subfolder,
                "type": image_type,
            }
            try:
                resp = self.http.post(
                    self._url("/upload/image"), files=files, data=data, timeout=max(self.timeout, 120)
                )
            except requests.RequestException as exc:
                raise ComfyError(f"upload of {path} failed: {exc}") from exc
        if not resp.ok:
            raise ComfyError(f"upload of {path} -> {resp.status_code}: {resp.text[:400]}")

        info = resp.json()
        name = info.get("name") or info.get("filename")
        if not name:
            raise ComfyError(f"upload response had no filename: {info}")
        sub = info.get("subfolder", "")
        # LoadImage addresses files as "subfolder/name" relative to the input dir.
        return f"{sub}/{name}" if sub else name

    # ------------------------------------------------------------------ queue
    def queue_prompt(self, graph: dict[str, Any]) -> str:
        payload = {"prompt": graph, "client_id": self.client_id}
        try:
            resp = self.http.post(self._url("/prompt"), json=payload, timeout=self.timeout)
        except requests.RequestException as exc:
            raise ComfyError(f"POST /prompt failed: {exc}") from exc

        if resp.status_code == 400:
            # ComfyUI returns structured validation errors here — surface them,
            # they name the exact node and input that is wrong.
            try:
                err = resp.json()
            except ValueError:
                raise ComfyError(f"prompt rejected: {resp.text[:600]}") from None
            raise ExecutionError(_format_validation_error(err), err)
        if not resp.ok:
            raise ComfyError(f"POST /prompt -> {resp.status_code}: {resp.text[:400]}")

        data = resp.json()
        if "prompt_id" not in data:
            raise ComfyError(f"no prompt_id in response: {data}")
        return data["prompt_id"]

    def interrupt(self) -> None:
        try:
            self.http.post(self._url("/interrupt"), timeout=self.timeout)
        except requests.RequestException:
            pass

    def history(self, prompt_id: str) -> dict[str, Any] | None:
        data = self._get(f"/history/{prompt_id}").json()
        return data.get(prompt_id)

    # --------------------------------------------------------------- execution
    def wait(
        self,
        prompt_id: str,
        timeout: int = 3600,
        on_progress: Callable[[Progress], None] | None = None,
        node_titles: dict[str, str] | None = None,
        poll_interval: float = 2.0,
    ) -> dict[str, Any]:
        """Block until `prompt_id` finishes. Returns its /history entry."""
        titles = node_titles or {}
        deadline = time.monotonic() + timeout
        ws = self._open_ws()
        ws_done = False
        entry: dict[str, Any] | None = None

        try:
            while True:
                # Check /history first so an already-finished job returns at once
                # instead of waiting out a poll interval.
                entry = self.history(prompt_id)
                if entry and entry.get("status", {}).get("completed") is not None:
                    break

                if time.monotonic() >= deadline:
                    self.interrupt()
                    raise ExecutionTimeout(f"prompt {prompt_id} exceeded {timeout}s")

                if ws is not None and not ws_done:
                    # Blocks until the next message or the socket read timeout.
                    ws_done = self._pump_ws(ws, prompt_id, titles, on_progress)
                else:
                    # The socket said "done" but /history has not caught up yet,
                    # or there is no socket at all.
                    time.sleep(0.25 if ws_done else poll_interval)
        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:  # noqa: BLE001
                    pass

        # /history is the authority on success, not the socket.
        if entry is None:
            raise ExecutionError(f"prompt {prompt_id} vanished from history without producing output")

        status = entry.get("status", {})
        if status.get("status_str") == "error" or status.get("completed") is False:
            raise ExecutionError(_format_history_error(entry), entry)

        if on_progress:
            on_progress(Progress(prompt_id, None, None, 1, 1, "done"))
        return entry

    def _open_ws(self):
        try:
            import websocket  # type: ignore
        except ModuleNotFoundError:
            return None
        scheme = "wss" if self.base_url.startswith("https") else "ws"
        host = self.base_url.split("://", 1)[1]
        url = f"{scheme}://{host}/ws?clientId={self.client_id}"
        try:
            ws = websocket.WebSocket()
            ws.connect(url, timeout=10)
            ws.settimeout(5)
            return ws
        except Exception:  # noqa: BLE001 — progress is optional, polling still works
            return None

    def _pump_ws(
        self,
        ws: Any,
        prompt_id: str,
        titles: dict[str, str],
        on_progress: Callable[[Progress], None] | None,
    ) -> bool:
        """Read one socket message. Returns True when this prompt is finished."""
        try:
            raw = ws.recv()
        except Exception:  # noqa: BLE001 — timeout or drop; caller falls back to /history
            return False
        if not raw or isinstance(raw, (bytes, bytearray)):
            return False  # binary frames are preview images; ignore

        try:
            msg = json.loads(raw)
        except ValueError:
            return False

        mtype = msg.get("type")
        data = msg.get("data", {}) or {}
        if data.get("prompt_id") not in (None, prompt_id):
            return False

        if mtype == "progress" and on_progress:
            node = data.get("node")
            on_progress(
                Progress(
                    prompt_id,
                    node,
                    titles.get(str(node)),
                    int(data.get("value", 0)),
                    int(data.get("max", 0)),
                    "sampling",
                )
            )
        elif mtype == "executing":
            node = data.get("node")
            if node is None and data.get("prompt_id") == prompt_id:
                return True  # null node == this prompt is done
            if on_progress:
                on_progress(Progress(prompt_id, node, titles.get(str(node)), 0, 0, "executing"))
        elif mtype == "execution_error":
            raise ExecutionError(
                f"node {data.get('node_type')} ({data.get('node_id')}): {data.get('exception_message')}",
                data,
            )
        elif mtype in ("execution_success", "execution_interrupted"):
            return True
        return False

    # ---------------------------------------------------------------- outputs
    @staticmethod
    def collect_outputs(history_entry: dict[str, Any]) -> list[OutputFile]:
        """Flatten every file a run produced, across node types."""
        found: list[OutputFile] = []
        for node_id, node_out in (history_entry.get("outputs") or {}).items():
            for kind, items in node_out.items():
                if not isinstance(items, list):
                    continue
                for item in items:
                    if not isinstance(item, dict) or "filename" not in item:
                        continue
                    found.append(
                        OutputFile(
                            filename=item["filename"],
                            subfolder=item.get("subfolder", ""),
                            type=item.get("type", "output"),
                            node_id=str(node_id),
                            kind=kind,
                        )
                    )
        return found

    def download(self, out: OutputFile, dest_path: str) -> str:
        params = {"filename": out.filename, "subfolder": out.subfolder, "type": out.type}
        try:
            with self.http.get(
                self._url("/view"), params=params, stream=True, timeout=max(self.timeout, 300)
            ) as resp:
                if not resp.ok:
                    raise ComfyError(f"/view {out.filename} -> {resp.status_code}")
                with open(dest_path, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1 << 20):
                        fh.write(chunk)
        except requests.RequestException as exc:
            raise ComfyError(f"download of {out.filename} failed: {exc}") from exc
        return dest_path


# ----------------------------------------------------------------- formatting
def _format_validation_error(err: dict[str, Any]) -> str:
    error = err.get("error", {}) or {}
    lines = [f"prompt rejected: {error.get('type', 'error')}: {error.get('message', '')}"]
    if error.get("details"):
        lines.append(f"  {error['details']}")
    for node_id, info in (err.get("node_errors") or {}).items():
        lines.append(f"  node {node_id} ({info.get('class_type', '?')}):")
        for e in info.get("errors", []):
            lines.append(f"    - {e.get('message')}: {e.get('details')}")
    return "\n".join(lines)


def _format_history_error(entry: dict[str, Any]) -> str:
    msgs: Iterable[Any] = entry.get("status", {}).get("messages", []) or []
    for name, payload in msgs:
        if name == "execution_error" and isinstance(payload, dict):
            return (
                f"execution failed in node {payload.get('node_id')} "
                f"({payload.get('node_type')}): {payload.get('exception_message')}"
            )
    return f"execution failed: {entry.get('status', {})}"
