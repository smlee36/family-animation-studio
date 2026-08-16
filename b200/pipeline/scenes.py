"""Discover scenes in a keyframes/ directory and decide output paths.

Naming rules (all under one flat folder):

    scene01_start.png     required — the first frame
    scene01_end.png       optional — enables first+last frame conditioning
    scene01_prompt.txt    optional — the prompt (falls back to --prompt / empty)
    scene01_preset.txt    optional — one line, the preset name for this scene
    scene01_negative.txt  optional — per-scene negative prompt override

    scene01.png           also accepted as a shorthand for scene01_start.png

Outputs are versioned rather than overwritten:

    clips/scene01_v1.mp4, then _v2, _v3 ... on each regeneration
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Iterable

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
_SUFFIX_RX = re.compile(r"^(?P<id>.+?)_(?P<role>start|end|first|last)$", re.IGNORECASE)
_VERSION_RX = re.compile(r"_v(\d+)$", re.IGNORECASE)

_ROLE_ALIASES = {"first": "start", "last": "end"}


class SceneError(RuntimeError):
    pass


@dataclass
class Scene:
    scene_id: str
    image_start: str
    image_end: str | None = None
    prompt: str = ""
    negative_prompt: str | None = None
    preset: str | None = None

    @property
    def has_end(self) -> bool:
        return self.image_end is not None


def _read_text(path: str) -> str | None:
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return fh.read().strip()


def _sidecar(dirpath: str, scene_id: str, suffix: str) -> str | None:
    """Find scene01_prompt.txt / .md, case-insensitively on the suffix."""
    for ext in (".txt", ".md"):
        candidate = os.path.join(dirpath, f"{scene_id}_{suffix}{ext}")
        if os.path.exists(candidate):
            return _read_text(candidate)
    return None


def discover(keyframes_dir: str, only: Iterable[str] | None = None) -> list[Scene]:
    """Scan `keyframes_dir` and return scenes sorted by id."""
    if not os.path.isdir(keyframes_dir):
        raise SceneError(f"keyframes directory not found: {keyframes_dir}")

    starts: dict[str, str] = {}
    ends: dict[str, str] = {}
    bare: dict[str, str] = {}

    for entry in sorted(os.listdir(keyframes_dir)):
        path = os.path.join(keyframes_dir, entry)
        if not os.path.isfile(path):
            continue
        stem, ext = os.path.splitext(entry)
        if ext.lower() not in IMAGE_EXTS:
            continue

        match = _SUFFIX_RX.match(stem)
        if match:
            scene_id = match.group("id")
            role = _ROLE_ALIASES.get(match.group("role").lower(), match.group("role").lower())
            target = starts if role == "start" else ends
            if scene_id in target:
                raise SceneError(
                    f"scene '{scene_id}' has two {role} frames: "
                    f"{os.path.basename(target[scene_id])} and {entry}. "
                    "Keep one image per role (differing extensions count as duplicates)."
                )
            target[scene_id] = path
        else:
            bare[stem] = path

    # A bare scene01.png counts as a start frame only if there is no explicit one.
    for scene_id, path in bare.items():
        starts.setdefault(scene_id, path)

    orphans = sorted(set(ends) - set(starts))
    if orphans:
        raise SceneError(
            f"end frame without a start frame for: {', '.join(orphans)}. "
            f"Add {orphans[0]}_start.png or rename the file."
        )

    wanted = set(only) if only else None
    scenes: list[Scene] = []
    for scene_id in sorted(starts):
        if wanted is not None and scene_id not in wanted:
            continue
        preset = _sidecar(keyframes_dir, scene_id, "preset")
        scenes.append(
            Scene(
                scene_id=scene_id,
                image_start=starts[scene_id],
                image_end=ends.get(scene_id),
                prompt=_sidecar(keyframes_dir, scene_id, "prompt") or "",
                negative_prompt=_sidecar(keyframes_dir, scene_id, "negative"),
                preset=preset.splitlines()[0].strip() if preset else None,
            )
        )

    if wanted is not None:
        missing = wanted - {s.scene_id for s in scenes}
        if missing:
            raise SceneError(f"requested scene(s) not found in {keyframes_dir}: {', '.join(sorted(missing))}")

    return scenes


def next_version(clips_dir: str, scene_id: str, ext: str = ".mp4") -> tuple[int, str]:
    """Next free version number and its full output path."""
    os.makedirs(clips_dir, exist_ok=True)
    highest = 0
    prefix = f"{scene_id}_v"
    for entry in os.listdir(clips_dir):
        stem, entry_ext = os.path.splitext(entry)
        if entry_ext.lower() != ext.lower() or not stem.startswith(prefix):
            continue
        match = _VERSION_RX.search(stem)
        if match and stem[: match.start()] == scene_id:
            highest = max(highest, int(match.group(1)))
    version = highest + 1
    return version, os.path.join(clips_dir, f"{scene_id}_v{version}{ext}")


def existing_versions(clips_dir: str, scene_id: str, ext: str = ".mp4") -> list[str]:
    if not os.path.isdir(clips_dir):
        return []
    out = []
    for entry in sorted(os.listdir(clips_dir)):
        stem, entry_ext = os.path.splitext(entry)
        if entry_ext.lower() != ext.lower():
            continue
        match = _VERSION_RX.search(stem)
        if match and stem[: match.start()] == scene_id:
            out.append(os.path.join(clips_dir, entry))
    return out
