"""Diff the shipped workflows against a live ComfyUI server and report fixes.

The graphs in workflows/ were authored without access to a running server, so
node class names, input names and the exact model filenames are the parts most
likely to be wrong on your install. This tool finds all three by comparing every
graph against /object_info, and suggests the closest real name for anything that
does not exist.

    python -m pipeline.doctor --url http://127.0.0.1:8188
    python -m pipeline.doctor --workflow ltx_i2v --verbose
    python -m pipeline.doctor --list-nodes ltx      # every node class matching "ltx"

Exit code is non-zero if any workflow has a problem, so it works as a gate in a
setup script.
"""

from __future__ import annotations

import argparse
import difflib
import os
import sys
from typing import Any

from .comfy_client import ComfyClient, ComfyError
from .workflow import WorkflowError, WorkflowRegistry, index_titles, load_graph

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_WORKFLOWS = os.path.join(ROOT, "workflows", "index.yaml")


def _schema_inputs(node_schema: dict[str, Any]) -> dict[str, Any]:
    """Flatten required+optional input definitions for one node class."""
    spec = node_schema.get("input", {}) or {}
    merged: dict[str, Any] = {}
    merged.update(spec.get("required", {}) or {})
    merged.update(spec.get("optional", {}) or {})
    return merged


def _enum_values(input_def: Any) -> list[str] | None:
    """ComfyUI encodes a dropdown as [[...choices...], {...opts...}]."""
    if isinstance(input_def, list) and input_def and isinstance(input_def[0], list):
        return [str(v) for v in input_def[0]]
    return None


def _suggest(name: str, pool: list[str], n: int = 3) -> list[str]:
    close = difflib.get_close_matches(name, pool, n=n, cutoff=0.5)
    if close:
        return close
    # Fall back to substring matching — "LTXVImgToVideo" vs "LTXVImageToVideo"
    # style renames sometimes score below the cutoff.
    lowered = name.lower()
    token = "".join(c for c in lowered if c.isalnum())
    hits = [p for p in pool if token[:6] and token[:6] in "".join(c for c in p.lower() if c.isalnum())]
    return hits[:n]


def check_workflow(
    name: str,
    registry: WorkflowRegistry,
    object_info: dict[str, Any],
    verbose: bool = False,
) -> list[str]:
    problems: list[str] = []
    spec = registry.get(name)

    try:
        graph = load_graph(spec)
    except WorkflowError as exc:
        return [f"cannot load graph: {exc}"]

    all_classes = sorted(object_info)

    # 1. node classes -------------------------------------------------------
    for node_id, node in sorted(graph.items()):
        cls = node["class_type"]
        title = (node.get("_meta") or {}).get("title", "")
        if cls in object_info:
            if verbose:
                print(f"    ok  node {node_id} {title or ''} -> {cls}")
            continue
        hint = _suggest(cls, all_classes)
        problems.append(
            f"node {node_id} ('{title}') uses class '{cls}' which this server does not have."
            + (f" Closest available: {', '.join(hint)}" if hint else " No similar node found — is the custom node pack installed?")
        )

    # 2. bound inputs exist -------------------------------------------------
    titles = index_titles(graph)
    for param, targets in sorted(spec.bindings.items()):
        for target in targets:
            node_id = titles.get(target.title)
            if node_id is None:
                problems.append(f"binding '{param}' -> title '{target.title}' but no node has that title")
                continue
            cls = graph[node_id]["class_type"]
            schema = object_info.get(cls)
            if schema is None:
                continue  # already reported as a missing class
            inputs = _schema_inputs(schema)
            if target.input not in inputs:
                hint = _suggest(target.input, sorted(inputs))
                problems.append(
                    f"binding '{param}' writes '{cls}.{target.input}', which does not exist."
                    + (f" Did you mean: {', '.join(hint)}?" if hint else f" Real inputs: {', '.join(sorted(inputs))}")
                )
            elif verbose:
                print(f"    ok  {param} -> {cls}.{target.input}")

    # 3. literal enum values (model filenames, sampler names) ---------------
    for node_id, node in sorted(graph.items()):
        cls = node["class_type"]
        schema = object_info.get(cls)
        if schema is None:
            continue
        inputs = _schema_inputs(schema)
        for key, value in node["inputs"].items():
            if isinstance(value, list):
                continue  # a wired link, not a literal
            choices = _enum_values(inputs.get(key))
            if choices is None or value in choices:
                continue
            hint = _suggest(str(value), choices)
            problems.append(
                f"node {node_id} ({cls}).{key} = '{value}' is not one of the server's choices."
                + (f" Available (closest): {', '.join(hint)}" if hint else f" Available: {', '.join(choices[:8]) or '(none — the model file is missing)'}")
            )

    return problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("COMFY_URL", "http://127.0.0.1:8188"))
    ap.add_argument("--workflows-file", default=DEFAULT_WORKFLOWS)
    ap.add_argument("--workflow", default="", help="check one workflow instead of all")
    ap.add_argument("--list-nodes", default="", help="print server node classes containing this substring")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    client = ComfyClient(args.url)
    try:
        object_info = client.object_info()
    except ComfyError as exc:
        print(f"cannot reach ComfyUI at {args.url}: {exc}", file=sys.stderr)
        print("start it with: b200/scripts/30_serve_comfyui.sh", file=sys.stderr)
        return 2

    print(f"server: {args.url} — {len(object_info)} node classes registered")

    if args.list_nodes:
        needle = args.list_nodes.lower()
        hits = sorted(c for c in object_info if needle in c.lower())
        print(f"\nnode classes matching '{args.list_nodes}' ({len(hits)}):")
        for cls in hits:
            print(f"  {cls}")
            if args.verbose:
                for key, definition in _schema_inputs(object_info[cls]).items():
                    choices = _enum_values(definition)
                    kind = f"[{', '.join(choices[:6])}{' ...' if choices and len(choices) > 6 else ''}]" if choices else (
                        definition[0] if isinstance(definition, list) and definition else "?"
                    )
                    print(f"      {key}: {kind}")
        return 0

    try:
        registry = WorkflowRegistry.load(args.workflows_file)
    except WorkflowError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2

    names = [args.workflow] if args.workflow else sorted(registry.workflows)
    total_problems = 0

    for name in names:
        spec = registry.get(name)
        print(f"\n=== {name}  ({os.path.basename(spec.graph_path)})")
        problems = check_workflow(name, registry, object_info, args.verbose)
        if not problems:
            print("  no problems found")
            continue
        total_problems += len(problems)
        for problem in problems:
            print(f"  ! {problem}")

    print()
    if total_problems:
        print(f"{total_problems} problem(s) found.")
        print("Fix by editing the graph in workflows/ (class names, model filenames) or the")
        print("bindings in workflows/index.yaml (input names). Re-run to confirm.")
        return 1

    print("all workflows validate against this server.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
