"""Preset loading and resolution.

A preset is a flat bag of generation parameters plus a workflow choice. Presets
inherit with `extends`, and can `drop` keys they inherited but must not send
(the Wan graphs have no LTX scheduler inputs, for instance).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

import yaml

# Keys that are preset metadata, not generation parameters bound into a graph.
META_KEYS = {"extends", "label", "notes", "drop", "workflow", "prompt_suffix"}


class PresetError(RuntimeError):
    pass


@dataclass
class Preset:
    name: str
    workflow: str
    label: str = ""
    notes: str = ""
    prompt_suffix: str = ""
    params: dict[str, Any] = field(default_factory=dict)

    def describe(self) -> str:
        keys = ("width", "height", "length", "frame_rate", "steps", "cfg")
        bits = [f"{k}={self.params[k]}" for k in keys if k in self.params]
        return f"{self.name} [{self.workflow}] " + " ".join(bits)


@dataclass
class PresetLibrary:
    presets: dict[str, Preset]

    @classmethod
    def load(cls, path: str) -> "PresetLibrary":
        if not os.path.exists(path):
            raise PresetError(f"preset file not found: {path}")
        with open(path) as fh:
            cfg = yaml.safe_load(fh) or {}

        base: dict[str, Any] = cfg.get("base") or {}
        raw: dict[str, Any] = cfg.get("presets") or {}
        if not raw:
            raise PresetError(f"{path} defines no presets")

        resolved: dict[str, Preset] = {}
        for name in raw:
            resolved[name] = _resolve(name, raw, base, seen=[])
        return cls(presets=resolved)

    def get(self, name: str) -> Preset:
        try:
            return self.presets[name]
        except KeyError:
            raise PresetError(
                f"unknown preset '{name}'. Available: {', '.join(sorted(self.presets))}"
            ) from None

    def names(self) -> list[str]:
        return sorted(self.presets)


def _resolve(
    name: str,
    raw: dict[str, Any],
    base: dict[str, Any],
    seen: list[str],
) -> Preset:
    if name in seen:
        raise PresetError(f"circular 'extends' chain: {' -> '.join(seen + [name])}")
    if name not in raw and name != "base":
        raise PresetError(f"preset '{name}' extends something that does not exist")

    entry: dict[str, Any] = dict(raw[name]) if name != "base" else dict(base)
    parent_name = entry.get("extends")

    if parent_name == "base" or (parent_name is None and name != "base"):
        merged: dict[str, Any] = dict(base)
    elif parent_name:
        parent = _resolve(parent_name, raw, base, seen + [name])
        merged = dict(parent.params)
        merged["workflow"] = parent.workflow
        if parent.prompt_suffix:
            merged["prompt_suffix"] = parent.prompt_suffix
    else:
        merged = {}

    merged.update(entry)

    for key in merged.pop("drop", []) or []:
        merged.pop(key, None)

    workflow = merged.get("workflow")
    if not workflow:
        raise PresetError(f"preset '{name}' has no workflow (set it here or in base)")

    params = {k: v for k, v in merged.items() if k not in META_KEYS}
    # Normalise the fields that ComfyUI is strict about.
    for int_key in ("width", "height", "length", "steps", "frame_rate", "interpolate_multiplier",
                    "out_width", "out_height"):
        if int_key in params and params[int_key] is not None:
            params[int_key] = int(params[int_key])
    for float_key in ("cfg", "max_shift", "base_shift", "terminal", "shift",
                      "guide_strength_start", "guide_strength_end"):
        if float_key in params and params[float_key] is not None:
            params[float_key] = float(params[float_key])

    _validate(name, params)

    return Preset(
        name=name,
        workflow=str(workflow),
        label=str(merged.get("label", "")),
        notes=str(merged.get("notes", "")),
        prompt_suffix=str(merged.get("prompt_suffix", "") or "").strip(),
        params=params,
    )


def _validate(name: str, params: dict[str, Any]) -> None:
    length = params.get("length")
    if length is not None:
        # LTX's temporal compression needs (8k + 1) frames; anything else is
        # silently truncated by the VAE and the clip comes out short.
        if length < 9 or (length - 1) % 8 != 0:
            raise PresetError(
                f"preset '{name}': length={length} must be (multiple of 8) + 1 and >= 9 "
                f"(nearest valid: {max(9, ((length - 1) // 8) * 8 + 1)})"
            )
    # Generation dimensions drive the latent grid and must be divisible by 32.
    # (This is why 720 is not a legal height: 720/32 = 22.5. Use 704.)
    for dim in ("width", "height"):
        val = params.get(dim)
        if val is not None and val % 32 != 0:
            raise PresetError(
                f"preset '{name}': {dim}={val} must be a multiple of 32 "
                f"(nearest: {round(val / 32) * 32})"
            )
    # Post-processing output size is a plain image resize — h264 only needs even.
    for dim in ("out_width", "out_height"):
        val = params.get(dim)
        if val is not None and val % 2 != 0:
            raise PresetError(f"preset '{name}': {dim}={val} must be even for h264 encoding")
    cfg = params.get("cfg")
    if cfg is not None and not (0.0 < cfg <= 30.0):
        raise PresetError(f"preset '{name}': cfg={cfg} is out of a sane range")
    steps = params.get("steps")
    if steps is not None and not (1 <= steps <= 200):
        raise PresetError(f"preset '{name}': steps={steps} is out of a sane range")
