"""Batch image-to-video: keyframes/ -> clips/, driven through the ComfyUI API.

Built for unattended overnight runs. A scene that fails is retried, then
recorded and stepped over; the run continues to the end and leaves a report
behind. Nothing is ever overwritten — regenerating a scene writes _v2, _v3, ...

    python -m pipeline.batch_generate --keyframes keyframes --clips clips
    python -m pipeline.batch_generate --preset action --scenes scene01,scene04
    python -m pipeline.batch_generate --model wan            # Phase 4 swap
    python -m pipeline.batch_generate --compare ltx,wan      # side-by-side
"""

from __future__ import annotations

import argparse
import json
import os
import random
import signal
import sys
import time
from typing import Any

from . import scenes as scenes_mod
from .comfy_client import ComfyClient, ComfyError, ExecutionError, ExecutionTimeout, Progress
from .presets import PresetError, PresetLibrary
from .report import RunReport, SceneResult
from .workflow import WorkflowError, WorkflowRegistry, apply_params, load_graph, node_titles_by_id

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

DEFAULT_PRESETS = os.path.join(ROOT, "config", "presets.yaml")
DEFAULT_WORKFLOWS = os.path.join(ROOT, "workflows", "index.yaml")

_INTERRUPTED = False


def _handle_sigint(signum, frame):  # noqa: ANN001, ARG001
    global _INTERRUPTED
    if _INTERRUPTED:
        print("\nsecond interrupt — exiting immediately", file=sys.stderr)
        raise SystemExit(130)
    _INTERRUPTED = True
    print("\ninterrupt received — finishing the current scene, then stopping.", file=sys.stderr)
    print("press Ctrl-C again to abort now.", file=sys.stderr)


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------------- presets
def resolve_preset_name(lib: PresetLibrary, requested: str, model: str) -> str:
    """Map a logical preset name onto the right one for `model`.

    `--model wan --preset action` picks `wan_action` if it exists, so switching
    models really is one flag rather than a second set of preset names to learn.
    """
    if model:
        prefixed = f"{model}_{requested}"
        if prefixed in lib.presets:
            return prefixed
    if requested in lib.presets:
        return requested
    raise PresetError(
        f"no preset '{requested}'"
        + (f" (nor '{model}_{requested}')" if model else "")
        + f". Available: {', '.join(lib.names())}"
    )


def choose_workflow(
    registry: WorkflowRegistry,
    preset_workflow: str,
    scene: scenes_mod.Scene,
    model: str,
) -> tuple[str, str | None]:
    """Pick the workflow for a scene; returns (workflow_name, warning)."""
    spec = registry.get(preset_workflow)

    if "image_end" in spec.requires and not scene.has_end:
        # Unattended runs must not die because one scene lacks an end frame.
        fallbacks = [
            w for w in registry.for_model(model or spec.model)
            if "image_end" not in w.requires and "image_start" in w.requires
        ]
        if not fallbacks:
            raise WorkflowError(
                f"scene '{scene.scene_id}' has no end frame and workflow '{preset_workflow}' "
                f"requires one; no single-frame workflow is registered for model '{model or spec.model}'"
            )
        chosen = sorted(fallbacks, key=lambda w: len(w.bindings), reverse=True)[0]
        return chosen.name, (
            f"no {scene.scene_id}_end image; falling back from '{preset_workflow}' to '{chosen.name}'"
        )

    return preset_workflow, None


# ------------------------------------------------------------------ generation
def build_params(
    spec_bindings: dict[str, Any],
    preset_params: dict[str, Any],
    scene: scenes_mod.Scene,
    prompt: str,
    negative: str | None,
    seed: int,
    filename_prefix: str,
    uploaded: dict[str, str],
) -> dict[str, Any]:
    """Assemble the parameter bag, dropping anything this workflow cannot bind."""
    params: dict[str, Any] = dict(preset_params)
    params["prompt"] = prompt
    params["seed"] = seed
    params["filename_prefix"] = filename_prefix
    if negative:
        params["negative_prompt"] = negative
    params["image_start"] = uploaded["start"]
    if scene.has_end and "end" in uploaded:
        params["image_end"] = uploaded["end"]

    # A preset is shared across workflows; silently drop keys the chosen graph
    # has no binding for rather than failing the scene.
    return {k: v for k, v in params.items() if k in spec_bindings}


def progress_printer(scene_id: str) -> Any:
    state = {"last": 0.0}

    def _cb(p: Progress) -> None:
        if p.stage == "sampling" and p.max_value:
            now = time.monotonic()
            if now - state["last"] < 2.0 and p.value < p.max_value:
                return
            state["last"] = now
            bar_len = 24
            filled = int(bar_len * p.fraction)
            bar = "#" * filled + "-" * (bar_len - filled)
            print(
                f"\r    {scene_id} [{bar}] {p.value}/{p.max_value}"
                + (f" {p.node_title}" if p.node_title else ""),
                end="",
                flush=True,
            )
        elif p.stage == "done":
            print("\r" + " " * 78 + "\r", end="", flush=True)

    return _cb


def generate_scene(
    client: ComfyClient,
    registry: WorkflowRegistry,
    lib: PresetLibrary,
    scene: scenes_mod.Scene,
    args: argparse.Namespace,
    model: str,
    clips_dir: str,
    index: int,
) -> SceneResult:
    started = time.monotonic()

    preset_name = resolve_preset_name(lib, scene.preset or args.preset, model)
    preset = lib.get(preset_name)

    workflow_name, warning = choose_workflow(registry, preset.workflow, scene, model)
    if warning:
        log(f"  ! {warning}")
    spec = registry.get(workflow_name)

    result = SceneResult(
        scene_id=scene.scene_id,
        status="failed",
        preset=preset_name,
        workflow=workflow_name,
        model=spec.model,
    )

    prompt = scene.prompt or args.prompt or ""
    if not prompt.strip():
        log(f"  ! {scene.scene_id}: no prompt found ({scene.scene_id}_prompt.txt missing and no --prompt)")
    if preset.prompt_suffix:
        prompt = f"{prompt.strip()}, {preset.prompt_suffix}".strip(", ").strip()
    negative = scene.negative_prompt or preset.params.get("negative_prompt")

    version, out_path = scenes_mod.next_version(clips_dir, scene.scene_id)
    result.version = version
    seed = args.seed + index if args.seed is not None else random.randint(0, 2**31 - 1)

    if args.dry_run:
        result.status = "skipped"
        result.seed = seed
        result.params = dict(preset.params)
        log(f"  dry-run: would write {out_path} via '{workflow_name}' [{preset_name}] seed={seed}")
        return result

    graph_template = load_graph(spec)

    attempts = args.retries + 1
    last_error: str | None = None

    for attempt in range(1, attempts + 1):
        result.attempts = attempt
        try:
            uploaded = {"start": client.upload_image(scene.image_start)}
            if scene.has_end:
                uploaded["end"] = client.upload_image(scene.image_end)  # type: ignore[arg-type]

            params = build_params(
                spec.bindings,
                preset.params,
                scene,
                prompt,
                negative,
                seed,
                f"b200/{scene.scene_id}_v{version}",
                uploaded,
            )
            graph = apply_params(spec, graph_template, params, strict=True)

            prompt_id = client.queue_prompt(graph)
            log(f"  queued {scene.scene_id} as {prompt_id} [{preset_name}/{workflow_name}] seed={seed}")

            entry = client.wait(
                prompt_id,
                timeout=args.timeout,
                on_progress=progress_printer(scene.scene_id),
                node_titles=node_titles_by_id(graph),
            )

            outputs = client.collect_outputs(entry)
            videos = [o for o in outputs if o.filename.lower().endswith((".mp4", ".webm", ".mkv", ".gif", ".webp"))]
            if not videos:
                raise ExecutionError(
                    f"run finished but produced no video file "
                    f"(outputs: {[o.filename for o in outputs] or 'none'}). "
                    "Check that the output node has save_output enabled."
                )

            chosen = videos[-1]
            ext = os.path.splitext(chosen.filename)[1] or ".mp4"
            if ext.lower() != ".mp4":
                version, out_path = scenes_mod.next_version(clips_dir, scene.scene_id, ext=ext)
            client.download(chosen, out_path)

            result.status = "ok"
            result.output_path = out_path
            result.seed = seed
            result.params = dict(params)
            result.vram = client.vram_summary()
            result.duration_s = time.monotonic() - started
            log(f"  ok {scene.scene_id} -> {out_path} ({result.duration_s:.0f}s)")
            return result

        except (ExecutionError, ExecutionTimeout, ComfyError, WorkflowError) as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            if attempt < attempts:
                backoff = min(2 ** attempt, 30)
                log(f"  ! {scene.scene_id} attempt {attempt}/{attempts} failed: {last_error.splitlines()[0]}")
                log(f"    retrying in {backoff}s")
                if args.reseed_on_retry:
                    seed = random.randint(0, 2**31 - 1)
                time.sleep(backoff)
            else:
                log(f"  FAILED {scene.scene_id} after {attempts} attempt(s)")

    result.error = last_error
    result.seed = seed
    result.duration_s = time.monotonic() - started
    return result


# ------------------------------------------------------------------------ main
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="batch_generate",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--keyframes", default=os.path.join(ROOT, "keyframes"))
    ap.add_argument("--clips", default=os.path.join(ROOT, "clips"))
    ap.add_argument("--url", default=os.environ.get("COMFY_URL", "http://127.0.0.1:8188"))
    ap.add_argument("--model", default="ltx", help="model family: ltx | wan")
    ap.add_argument("--compare", default="", help="comma-separated models; writes clips/<model>/")
    ap.add_argument("--preset", default="calm", help="default preset (a scene's _preset.txt wins)")
    ap.add_argument("--scenes", default="", help="comma-separated scene ids; default is all")
    ap.add_argument("--prompt", default="", help="fallback prompt for scenes with no _prompt.txt")
    ap.add_argument("--seed", type=int, default=None, help="base seed; scene N uses seed+N. Default random.")
    ap.add_argument("--reseed-on-retry", action="store_true", help="use a fresh seed on each retry")
    ap.add_argument("--retries", type=int, default=1, help="retries per scene after the first attempt")
    ap.add_argument("--timeout", type=int, default=3600, help="per-scene timeout in seconds")
    ap.add_argument("--connect-timeout", type=int, default=120,
                    help="how long to wait for ComfyUI to come up before giving up")
    ap.add_argument("--skip-existing", action="store_true", help="skip scenes that already have a clip")
    ap.add_argument("--dry-run", action="store_true", help="resolve everything, generate nothing")
    ap.add_argument("--stop-on-error", action="store_true", help="abort the run on the first failure")
    ap.add_argument("--presets-file", default=DEFAULT_PRESETS)
    ap.add_argument("--workflows-file", default=DEFAULT_WORKFLOWS)
    ap.add_argument("--report-dir", default="", help="default: <clips>/_reports")
    ap.add_argument("--list-presets", action="store_true")
    ap.add_argument("--no-validate", action="store_true", help="skip the up-front node-availability check")
    return ap


def preflight_nodes(client: ComfyClient, registry: WorkflowRegistry, needed: set[str]) -> list[str]:
    """Check every workflow we might run against the server's real node list."""
    try:
        available = client.available_nodes()
    except ComfyError as exc:
        return [f"could not read /object_info ({exc}); skipping node validation"]

    problems: list[str] = []
    for name in sorted(needed):
        spec = registry.get(name)
        try:
            graph = load_graph(spec)
        except WorkflowError as exc:
            problems.append(str(exc))
            continue
        missing = sorted({n["class_type"] for n in graph.values()} - available)
        if missing:
            problems.append(
                f"workflow '{name}' needs node class(es) this server does not have: {', '.join(missing)}"
            )
    return problems


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    signal.signal(signal.SIGINT, _handle_sigint)

    try:
        lib = PresetLibrary.load(args.presets_file)
        registry = WorkflowRegistry.load(args.workflows_file)
    except (PresetError, WorkflowError) as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2

    if args.list_presets:
        for name in lib.names():
            p = lib.get(name)
            print(f"{p.describe()}\n    {p.label}")
        return 0

    models = [m.strip() for m in args.compare.split(",") if m.strip()] or [args.model]

    try:
        only = [s.strip() for s in args.scenes.split(",") if s.strip()] or None
        found = scenes_mod.discover(args.keyframes, only)
    except scenes_mod.SceneError as exc:
        print(f"scene discovery failed: {exc}", file=sys.stderr)
        return 2

    if not found:
        print(f"no scenes found in {args.keyframes}", file=sys.stderr)
        print("expected files like scene01_start.png / scene01_end.png / scene01_prompt.txt", file=sys.stderr)
        return 1

    log(f"{len(found)} scene(s): {', '.join(s.scene_id for s in found)}")
    log(f"model(s): {', '.join(models)}   preset default: {args.preset}")

    client = ComfyClient(args.url)
    if not args.dry_run:
        try:
            client.wait_until_ready(timeout=args.connect_timeout)
        except ComfyError as exc:
            print(f"cannot reach ComfyUI at {args.url}: {exc}", file=sys.stderr)
            print("start it with: b200/scripts/30_serve_comfyui.sh", file=sys.stderr)
            return 1
        log(f"ComfyUI ready — {client.vram_summary()}")

    overall_failures = 0

    for model in models:
        clips_dir = os.path.join(args.clips, model) if len(models) > 1 else args.clips
        os.makedirs(clips_dir, exist_ok=True)

        report = RunReport(
            model=model,
            keyframes_dir=os.path.abspath(args.keyframes),
            clips_dir=os.path.abspath(clips_dir),
            comfy_url=args.url,
        )

        # Validate the workflows this run could touch before burning an hour.
        if not args.dry_run and not args.no_validate:
            needed: set[str] = set()
            for scene in found:
                try:
                    pname = resolve_preset_name(lib, scene.preset or args.preset, model)
                    wname, _ = choose_workflow(registry, lib.get(pname).workflow, scene, model)
                    needed.add(wname)
                except (PresetError, WorkflowError) as exc:
                    print(f"config error for scene '{scene.scene_id}': {exc}", file=sys.stderr)
                    return 2
            for problem in preflight_nodes(client, registry, needed):
                log(f"  ! {problem}")
                log("    run `python -m pipeline.doctor` for the full diff and suggested fixes")

        for index, scene in enumerate(found):
            if _INTERRUPTED:
                log("stopping early (interrupted)")
                break

            log(f"[{index + 1}/{len(found)}] {scene.scene_id} ({model})")

            if args.skip_existing and scenes_mod.existing_versions(clips_dir, scene.scene_id):
                log("  skipped: a clip already exists (--skip-existing)")
                report.add(SceneResult(scene_id=scene.scene_id, status="skipped", model=model))
                continue

            try:
                result = generate_scene(client, registry, lib, scene, args, model, clips_dir, index)
            except (PresetError, WorkflowError) as exc:
                result = SceneResult(scene_id=scene.scene_id, status="failed", model=model, error=str(exc))
                log(f"  FAILED {scene.scene_id}: {exc}")

            report.add(result)

            if result.status == "failed":
                overall_failures += 1
                if args.stop_on_error:
                    log("aborting: --stop-on-error")
                    break

        report_dir = args.report_dir or os.path.join(args.clips, "_reports")
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base = os.path.join(report_dir, f"run-{stamp}-{model}")
        report.write_json(base + ".json")
        report.write_markdown(base + ".md")

        print(report.console_summary())
        log(f"report: {base}.md")

    return 1 if overall_failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
