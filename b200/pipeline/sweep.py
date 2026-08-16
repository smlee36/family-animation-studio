"""Parameter sweep: generate one clip per combination so presets can be tuned
from evidence instead of intuition.

    python -m pipeline.sweep --image kf/scene01_start.png \
        --axis steps=20,30,40 --axis cfg=2.5,3.0,3.5

Every clip is written with the parameter values in its filename, and an
index.md is produced listing the grid so the outputs can be reviewed side by
side. The winning row goes into config/presets.yaml.
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import sys
import time
from typing import Any

from .comfy_client import ComfyClient, ComfyError
from .presets import PresetError, PresetLibrary
from .workflow import WorkflowError, WorkflowRegistry, apply_params, load_graph, node_titles_by_id

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PRESETS = os.path.join(ROOT, "config", "presets.yaml")
DEFAULT_WORKFLOWS = os.path.join(ROOT, "workflows", "index.yaml")


def parse_axis(raw: str) -> tuple[str, list[Any]]:
    if "=" not in raw:
        raise argparse.ArgumentTypeError(f"--axis needs name=v1,v2,... (got '{raw}')")
    name, values = raw.split("=", 1)
    parsed: list[Any] = []
    for chunk in values.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            parsed.append(int(chunk))
        except ValueError:
            try:
                parsed.append(float(chunk))
            except ValueError:
                parsed.append(chunk)
    if not parsed:
        raise argparse.ArgumentTypeError(f"--axis '{raw}' has no values")
    return name.strip(), parsed


def slug(value: Any) -> str:
    return str(value).replace(".", "p").replace("/", "-").replace(" ", "")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", required=True, help="start keyframe")
    ap.add_argument("--image-end", default="", help="end keyframe (enables the first+last workflow)")
    ap.add_argument("--prompt", default="", help="prompt text, or a path to a .txt file")
    ap.add_argument("--base-preset", default="calm", help="preset the sweep varies from")
    ap.add_argument("--axis", action="append", default=[], help="name=v1,v2,... (repeatable)")
    ap.add_argument("--out", default="", help="output dir (default: <b200>/sweeps/<timestamp>)")
    ap.add_argument("--url", default=os.environ.get("COMFY_URL", "http://127.0.0.1:8188"))
    ap.add_argument("--seed", type=int, default=1234, help="fixed across the grid so only the axes vary")
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--max-runs", type=int, default=24, help="refuse to start a grid larger than this")
    ap.add_argument("--presets-file", default=DEFAULT_PRESETS)
    ap.add_argument("--workflows-file", default=DEFAULT_WORKFLOWS)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    try:
        lib = PresetLibrary.load(args.presets_file)
        registry = WorkflowRegistry.load(args.workflows_file)
        preset = lib.get(args.base_preset)
    except (PresetError, WorkflowError) as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2

    if not os.path.exists(args.image):
        print(f"image not found: {args.image}", file=sys.stderr)
        return 2

    workflow_name = preset.workflow
    if not args.image_end:
        spec_probe = registry.get(workflow_name)
        if "image_end" in spec_probe.requires:
            singles = [w for w in registry.for_model(spec_probe.model) if "image_end" not in w.requires]
            if not singles:
                print(f"'{workflow_name}' needs an end frame; pass --image-end", file=sys.stderr)
                return 2
            workflow_name = singles[0].name
            print(f"no --image-end: sweeping with '{workflow_name}' instead of '{preset.workflow}'")
    spec = registry.get(workflow_name)

    axes = [parse_axis(a) for a in args.axis]
    if not axes:
        # A sensible default grid for illustration-style I2V tuning.
        axes = [("steps", [20, 30, 40]), ("cfg", [2.5, 3.0, 3.5])]
        print("no --axis given; using the default grid steps x cfg")

    for name, _ in axes:
        if name not in spec.bindings:
            print(
                f"workflow '{workflow_name}' has no binding for axis '{name}'. "
                f"Bindable: {', '.join(sorted(spec.bindings))}",
                file=sys.stderr,
            )
            return 2

    combos = list(itertools.product(*[values for _, values in axes]))
    if len(combos) > args.max_runs:
        print(
            f"grid is {len(combos)} runs, over --max-runs={args.max_runs}. "
            "Narrow the axes or raise the limit deliberately.",
            file=sys.stderr,
        )
        return 2

    prompt = args.prompt
    if prompt and os.path.exists(prompt):
        with open(prompt, encoding="utf-8") as fh:
            prompt = fh.read().strip()
    if preset.prompt_suffix:
        prompt = f"{prompt.strip()}, {preset.prompt_suffix}".strip(", ").strip()

    out_dir = args.out or os.path.join(ROOT, "sweeps", time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(out_dir, exist_ok=True)

    axis_names = [n for n, _ in axes]
    print(f"sweeping {len(combos)} combination(s) over {' x '.join(axis_names)}")
    print(f"base preset: {preset.describe()}")
    print(f"output: {out_dir}")

    if args.dry_run:
        for combo in combos:
            print("  " + " ".join(f"{n}={v}" for n, v in zip(axis_names, combo)))
        return 0

    client = ComfyClient(args.url)
    try:
        client.wait_until_ready(timeout=60)
    except ComfyError as exc:
        print(f"cannot reach ComfyUI: {exc}", file=sys.stderr)
        return 1

    graph_template = load_graph(spec)
    uploaded_start = client.upload_image(args.image)
    uploaded_end = client.upload_image(args.image_end) if args.image_end else None

    rows: list[dict[str, Any]] = []
    for i, combo in enumerate(combos, 1):
        overrides = dict(zip(axis_names, combo))
        label = "_".join(f"{n}{slug(v)}" for n, v in overrides.items())
        print(f"[{i}/{len(combos)}] {label}", flush=True)

        params: dict[str, Any] = dict(preset.params)
        params.update(overrides)
        params["prompt"] = prompt
        params["seed"] = args.seed
        params["image_start"] = uploaded_start
        if uploaded_end:
            params["image_end"] = uploaded_end
        params["filename_prefix"] = f"b200/sweep_{label}"
        params = {k: v for k, v in params.items() if k in spec.bindings}

        row: dict[str, Any] = {**overrides, "label": label, "status": "failed", "seconds": 0.0}
        started = time.monotonic()
        try:
            graph = apply_params(spec, graph_template, params, strict=True)
            prompt_id = client.queue_prompt(graph)
            entry = client.wait(prompt_id, timeout=args.timeout, node_titles=node_titles_by_id(graph))
            videos = [o for o in client.collect_outputs(entry)
                      if o.filename.lower().endswith((".mp4", ".webm", ".gif", ".webp"))]
            if not videos:
                raise ComfyError("no video produced")
            ext = os.path.splitext(videos[-1].filename)[1] or ".mp4"
            dest = os.path.join(out_dir, f"{label}{ext}")
            client.download(videos[-1], dest)
            row["status"] = "ok"
            row["file"] = os.path.basename(dest)
        except (ComfyError, WorkflowError) as exc:
            row["error"] = f"{type(exc).__name__}: {exc}"
            print(f"    failed: {row['error'].splitlines()[0]}", file=sys.stderr)
        row["seconds"] = round(time.monotonic() - started, 1)
        rows.append(row)

    manifest = {
        "base_preset": args.base_preset,
        "workflow": workflow_name,
        "seed": args.seed,
        "image": os.path.abspath(args.image),
        "image_end": os.path.abspath(args.image_end) if args.image_end else None,
        "prompt": prompt,
        "axes": {n: v for n, v in axes},
        "runs": rows,
    }
    with open(os.path.join(out_dir, "sweep.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)

    lines = [
        f"# Sweep {os.path.basename(out_dir)}",
        "",
        f"- base preset: `{args.base_preset}` — workflow `{workflow_name}`",
        f"- seed fixed at `{args.seed}` so differences come only from the axes",
        f"- start frame: `{manifest['image']}`",
        "",
        "| " + " | ".join(axis_names) + " | time | clip |",
        "| " + " | ".join("---" for _ in axis_names) + " | --- | --- |",
    ]
    for row in rows:
        cells = [str(row[n]) for n in axis_names]
        clip = f"[{row['file']}]({row['file']})" if row.get("file") else f"FAILED: {row.get('error', '')[:80]}"
        lines.append("| " + " | ".join(cells) + f" | {row['seconds']}s | {clip} |")
    lines += [
        "",
        "## How to read this",
        "",
        "Watch for, in order: (1) does the linework/watercolour texture survive, or",
        "does it boil frame to frame; (2) does the face stay the same person; (3) is",
        "the motion the amount the scene wants. Then copy the winning row's values",
        "into `config/presets.yaml`.",
        "",
    ]
    with open(os.path.join(out_dir, "index.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    ok_count = sum(1 for r in rows if r["status"] == "ok")
    print(f"\n{ok_count}/{len(rows)} clips generated")
    print(f"review: {os.path.join(out_dir, 'index.md')}")
    return 0 if ok_count == len(rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
