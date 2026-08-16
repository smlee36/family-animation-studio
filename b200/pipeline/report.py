"""Run bookkeeping: per-scene results, a JSON record, and a Markdown summary.

Written for the unattended overnight case — the report is the thing you read in
the morning to find out which scenes need another pass and why.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import platform
from dataclasses import asdict, dataclass, field
from typing import Any


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def _fmt_duration(seconds: float) -> str:
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}h{m:02d}m{s:02d}s" if h else (f"{m}m{s:02d}s" if m else f"{s}s")


@dataclass
class SceneResult:
    scene_id: str
    status: str  # "ok" | "failed" | "skipped"
    preset: str = ""
    workflow: str = ""
    model: str = ""
    output_path: str | None = None
    version: int | None = None
    seed: int | None = None
    duration_s: float = 0.0
    attempts: int = 1
    error: str | None = None
    vram: str = ""
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class RunReport:
    started_at: str = field(default_factory=_now)
    finished_at: str = ""
    model: str = ""
    keyframes_dir: str = ""
    clips_dir: str = ""
    comfy_url: str = ""
    host: str = field(default_factory=platform.node)
    results: list[SceneResult] = field(default_factory=list)

    # ------------------------------------------------------------------ status
    def add(self, result: SceneResult) -> None:
        self.results.append(result)

    @property
    def ok(self) -> list[SceneResult]:
        return [r for r in self.results if r.status == "ok"]

    @property
    def failed(self) -> list[SceneResult]:
        return [r for r in self.results if r.status == "failed"]

    @property
    def skipped(self) -> list[SceneResult]:
        return [r for r in self.results if r.status == "skipped"]

    @property
    def total_duration(self) -> float:
        return sum(r.duration_s for r in self.results)

    # ------------------------------------------------------------------ output
    def to_dict(self) -> dict[str, Any]:
        return {
            "started_at": self.started_at,
            "finished_at": self.finished_at or _now(),
            "host": self.host,
            "model": self.model,
            "keyframes_dir": self.keyframes_dir,
            "clips_dir": self.clips_dir,
            "comfy_url": self.comfy_url,
            "summary": {
                "total": len(self.results),
                "ok": len(self.ok),
                "failed": len(self.failed),
                "skipped": len(self.skipped),
                "wall_time_s": round(self.total_duration, 1),
            },
            "results": [asdict(r) for r in self.results],
        }

    def write_json(self, path: str) -> str:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.to_dict(), fh, indent=2, ensure_ascii=False)
        return path

    def to_markdown(self) -> str:
        d = self.to_dict()
        s = d["summary"]
        lines = [
            "# Batch generation report",
            "",
            f"- started: `{d['started_at']}`",
            f"- finished: `{d['finished_at']}`",
            f"- host: `{d['host']}`  model: `{d['model']}`",
            f"- keyframes: `{d['keyframes_dir']}`",
            f"- clips: `{d['clips_dir']}`",
            "",
            f"**{s['ok']} ok / {s['failed']} failed / {s['skipped']} skipped**"
            f" — total generation time {_fmt_duration(s['wall_time_s'])}",
            "",
            "| scene | status | preset | time | seed | output |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for r in self.results:
            mark = {"ok": "ok", "failed": "FAILED", "skipped": "skipped"}[r.status]
            out = os.path.basename(r.output_path) if r.output_path else "—"
            retry = f" (×{r.attempts})" if r.attempts > 1 else ""
            lines.append(
                f"| `{r.scene_id}` | {mark}{retry} | {r.preset or '—'} | "
                f"{_fmt_duration(r.duration_s)} | {r.seed if r.seed is not None else '—'} | {out} |"
            )

        if self.failed:
            lines += ["", "## Failures", ""]
            for r in self.failed:
                lines += [f"### `{r.scene_id}`", "", "```", (r.error or "unknown error").strip(), "```", ""]

        if self.ok:
            avg = sum(r.duration_s for r in self.ok) / len(self.ok)
            lines += ["", f"Average successful clip: {_fmt_duration(avg)}."]
            vram = next((r.vram for r in reversed(self.ok) if r.vram), "")
            if vram:
                lines.append(f"VRAM at last successful clip: {vram}")

        return "\n".join(lines) + "\n"

    def write_markdown(self, path: str) -> str:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(self.to_markdown())
        return path

    def console_summary(self) -> str:
        parts = [
            "",
            "=" * 64,
            f"  {len(self.ok)} ok   {len(self.failed)} failed   {len(self.skipped)} skipped"
            f"   ({_fmt_duration(self.total_duration)})",
        ]
        for r in self.failed:
            first_line = (r.error or "").strip().splitlines()[0] if r.error else "unknown error"
            parts.append(f"  FAILED  {r.scene_id}: {first_line}")
        parts.append("=" * 64)
        return "\n".join(parts)
