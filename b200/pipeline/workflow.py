"""Load ComfyUI graphs and bind logical parameters into them.

The pipeline never touches node ids directly. It says "set prompt" and the
binding table in workflows/index.yaml decides which node input(s) that lands in,
looked up by the node's `_meta.title`. Retitling or renumbering a graph in the
ComfyUI editor therefore does not break the batch runner.
"""

from __future__ import annotations

import copy
import json
import os
from dataclasses import dataclass, field
from typing import Any

import yaml


class WorkflowError(RuntimeError):
    pass


@dataclass
class Binding:
    title: str
    input: str
    scale_by: str | None = None  # name of another parameter to multiply by


@dataclass
class WorkflowSpec:
    name: str
    label: str
    graph_path: str
    model: str
    requires: list[str] = field(default_factory=list)
    accepts: list[str] = field(default_factory=list)
    bindings: dict[str, list[Binding]] = field(default_factory=dict)
    output_title: str = "B200::output"

    def supports(self, param: str) -> bool:
        return param in self.bindings


@dataclass
class WorkflowRegistry:
    root: str
    defaults: dict[str, Any]
    workflows: dict[str, WorkflowSpec]

    @classmethod
    def load(cls, index_path: str) -> "WorkflowRegistry":
        with open(index_path) as fh:
            cfg = yaml.safe_load(fh)
        root = os.path.dirname(os.path.abspath(index_path))

        specs: dict[str, WorkflowSpec] = {}
        for name, entry in (cfg.get("workflows") or {}).items():
            bindings: dict[str, list[Binding]] = {}
            for param, targets in (entry.get("bindings") or {}).items():
                bindings[param] = [
                    Binding(title=t["title"], input=t["input"], scale_by=t.get("scale_by"))
                    for t in targets
                ]
            specs[name] = WorkflowSpec(
                name=name,
                label=entry.get("label", name),
                graph_path=os.path.join(root, entry["graph"]),
                model=entry.get("model", "ltx"),
                requires=list(entry.get("requires") or []),
                accepts=list(entry.get("accepts") or []),
                bindings=bindings,
                output_title=entry.get("output_title", "B200::output"),
            )

        if not specs:
            raise WorkflowError(f"no workflows defined in {index_path}")
        return cls(root=root, defaults=cfg.get("defaults") or {}, workflows=specs)

    def get(self, name: str) -> WorkflowSpec:
        try:
            return self.workflows[name]
        except KeyError:
            raise WorkflowError(
                f"unknown workflow '{name}'. Available: {', '.join(sorted(self.workflows))}"
            ) from None

    def for_model(self, model: str) -> list[WorkflowSpec]:
        return [w for w in self.workflows.values() if w.model == model]


def load_graph(spec: WorkflowSpec) -> dict[str, Any]:
    if not os.path.exists(spec.graph_path):
        raise WorkflowError(f"graph file missing: {spec.graph_path}")
    with open(spec.graph_path) as fh:
        graph = json.load(fh)
    if not isinstance(graph, dict) or not graph:
        raise WorkflowError(f"{spec.graph_path} is not a non-empty API-format graph object")
    for node_id, node in graph.items():
        if "class_type" not in node or "inputs" not in node:
            raise WorkflowError(
                f"{spec.graph_path}: node '{node_id}' lacks class_type/inputs. "
                "Export from ComfyUI with 'Save (API format)', not the editor format."
            )
    return graph


def index_titles(graph: dict[str, Any]) -> dict[str, str]:
    """title -> node_id. Raises if two nodes claim the same B200:: title."""
    out: dict[str, str] = {}
    for node_id, node in graph.items():
        title = (node.get("_meta") or {}).get("title")
        if not title:
            continue
        if title in out and title.startswith("B200::"):
            raise WorkflowError(
                f"duplicate node title '{title}' on nodes {out[title]} and {node_id}; "
                "B200:: titles must be unique because bindings resolve by title"
            )
        out[title] = node_id
    return out


def node_titles_by_id(graph: dict[str, Any]) -> dict[str, str]:
    return {nid: (n.get("_meta") or {}).get("title", n.get("class_type", "?")) for nid, n in graph.items()}


def apply_params(
    spec: WorkflowSpec,
    graph: dict[str, Any],
    params: dict[str, Any],
    strict: bool = True,
) -> dict[str, Any]:
    """Return a copy of `graph` with `params` written through the bindings.

    strict=True raises on a parameter with no binding in this workflow; that is
    the right default for a batch run, where a silently ignored `cfg` would mean
    every clip is generated with the wrong settings.
    """
    graph = copy.deepcopy(graph)
    titles = index_titles(graph)
    unbound: list[str] = []

    for param, value in params.items():
        if value is None:
            continue
        targets = spec.bindings.get(param)
        if not targets:
            unbound.append(param)
            continue

        for target in targets:
            node_id = titles.get(target.title)
            if node_id is None:
                raise WorkflowError(
                    f"workflow '{spec.name}': binding for '{param}' points at node title "
                    f"'{target.title}', which does not exist in {os.path.basename(spec.graph_path)}. "
                    f"Titles present: {', '.join(sorted(t for t in titles if t.startswith('B200::')))}"
                )

            final = value
            if target.scale_by:
                factor = params.get(target.scale_by, spec_default(spec, target.scale_by, 1))
                try:
                    final = type(value)(value * factor) if isinstance(value, (int, float)) else value
                except (TypeError, ValueError) as exc:
                    raise WorkflowError(
                        f"cannot scale '{param}' by '{target.scale_by}': {exc}"
                    ) from exc

            node_inputs = graph[node_id]["inputs"]
            if target.input not in node_inputs and strict:
                raise WorkflowError(
                    f"workflow '{spec.name}': node '{target.title}' "
                    f"({graph[node_id]['class_type']}) has no input '{target.input}'. "
                    f"Inputs present: {', '.join(node_inputs)}. "
                    "Run `python -m pipeline.doctor` against a live server to see the real schema."
                )
            # Never clobber a wired connection with a literal.
            if isinstance(node_inputs.get(target.input), list):
                raise WorkflowError(
                    f"workflow '{spec.name}': input '{target.input}' of '{target.title}' is wired "
                    "to another node; a binding cannot overwrite a link."
                )
            node_inputs[target.input] = final

    if unbound and strict:
        raise WorkflowError(
            f"workflow '{spec.name}' has no binding for: {', '.join(sorted(unbound))}. "
            f"Either add it to workflows/index.yaml or drop it from the preset."
        )
    return graph


def spec_default(spec: WorkflowSpec, param: str, fallback: Any) -> Any:
    del spec
    return fallback


def class_types(graph: dict[str, Any]) -> set[str]:
    return {n["class_type"] for n in graph.values()}
