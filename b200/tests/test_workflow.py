import json
import os

import pytest

from pipeline.workflow import (
    WorkflowError,
    WorkflowRegistry,
    apply_params,
    index_titles,
    load_graph,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "workflows", "index.yaml")


@pytest.fixture(scope="module")
def registry():
    return WorkflowRegistry.load(INDEX)


def test_all_shipped_graphs_are_valid_api_format(registry):
    for name in registry.workflows:
        graph = load_graph(registry.get(name))
        assert graph, name
        for node_id, node in graph.items():
            assert isinstance(node["inputs"], dict), f"{name}:{node_id}"


def test_every_binding_target_title_exists(registry):
    # This is the check that catches a graph edit that renames a node but
    # forgets index.yaml — it would otherwise fail mid-run.
    for name, spec in registry.workflows.items():
        titles = index_titles(load_graph(spec))
        for param, targets in spec.bindings.items():
            for target in targets:
                assert target.title in titles, f"{name}: {param} -> missing title {target.title}"


def test_every_binding_input_exists_in_graph(registry):
    for name, spec in registry.workflows.items():
        graph = load_graph(spec)
        titles = index_titles(graph)
        for param, targets in spec.bindings.items():
            for target in targets:
                node = graph[titles[target.title]]
                assert target.input in node["inputs"], (
                    f"{name}: {param} -> {node['class_type']}.{target.input} not in graph"
                )


def test_output_title_present(registry):
    for name, spec in registry.workflows.items():
        assert spec.output_title in index_titles(load_graph(spec)), name


def test_apply_params_writes_through_bindings(registry):
    spec = registry.get("ltx_i2v_firstlast")
    graph = load_graph(spec)
    out = apply_params(spec, graph, {
        "prompt": "a quiet room",
        "width": 960,
        "height": 544,
        "steps": 22,
        "cfg": 2.5,
        "seed": 4242,
    })
    titles = index_titles(out)
    assert out[titles["B200::prompt"]]["inputs"]["text"] == "a quiet room"
    assert out[titles["B200::latent"]]["inputs"]["width"] == 960
    assert out[titles["B200::scheduler"]]["inputs"]["steps"] == 22
    assert out[titles["B200::sampler"]]["inputs"]["cfg"] == 2.5
    assert out[titles["B200::sampler"]]["inputs"]["noise_seed"] == 4242


def test_apply_params_does_not_mutate_the_template(registry):
    spec = registry.get("ltx_i2v")
    graph = load_graph(spec)
    before = json.dumps(graph, sort_keys=True)
    apply_params(spec, graph, {"prompt": "changed"})
    assert json.dumps(graph, sort_keys=True) == before


def test_one_param_can_drive_several_inputs(registry):
    spec = registry.get("ltx_i2v_firstlast")
    out = apply_params(spec, load_graph(spec), {"frame_rate": 30})
    titles = index_titles(out)
    assert out[titles["B200::conditioning"]]["inputs"]["frame_rate"] == 30
    assert out[titles["B200::output"]]["inputs"]["frame_rate"] == 30


def test_scale_by_multiplies_for_the_muxer(registry):
    # After 2x interpolation the muxer must run at 2x fps or playback is slowed.
    spec = registry.get("ltx_i2v_firstlast_post")
    out = apply_params(spec, load_graph(spec), {
        "frame_rate": 24,
        "interpolate_multiplier": 3,
    })
    titles = index_titles(out)
    assert out[titles["B200::conditioning"]]["inputs"]["frame_rate"] == 24
    assert out[titles["B200::output"]]["inputs"]["frame_rate"] == 72
    assert out[titles["B200::interpolate"]]["inputs"]["multiplier"] == 3


def test_unbound_param_raises_in_strict_mode(registry):
    spec = registry.get("wan_i2v")
    with pytest.raises(WorkflowError, match="no binding for: max_shift"):
        apply_params(spec, load_graph(spec), {"max_shift": 2.0})


def test_unbound_param_ignored_when_not_strict(registry):
    spec = registry.get("wan_i2v")
    out = apply_params(spec, load_graph(spec), {"max_shift": 2.0}, strict=False)
    assert out  # no exception, nothing written


def test_binding_cannot_overwrite_a_wired_link(registry, tmp_path):
    spec = registry.get("ltx_i2v")
    graph = load_graph(spec)
    titles = index_titles(graph)
    # `clip` on the prompt node is a link; rebinding text -> clip must be refused.
    spec.bindings["prompt"][0].input = "clip"
    try:
        with pytest.raises(WorkflowError, match="wired to another node"):
            apply_params(spec, graph, {"prompt": "x"})
    finally:
        spec.bindings["prompt"][0].input = "text"
    assert titles


def test_duplicate_b200_titles_are_rejected(tmp_path):
    graph = {
        "1": {"class_type": "CLIPTextEncode", "_meta": {"title": "B200::prompt"}, "inputs": {"text": ""}},
        "2": {"class_type": "CLIPTextEncode", "_meta": {"title": "B200::prompt"}, "inputs": {"text": ""}},
    }
    with pytest.raises(WorkflowError, match="duplicate node title"):
        index_titles(graph)


def test_editor_format_graph_is_rejected(tmp_path):
    bad = tmp_path / "editor.json"
    bad.write_text(json.dumps({"nodes": [], "links": []}), encoding="utf-8")
    # Fresh registry so mutating the spec cannot leak into other tests.
    spec = WorkflowRegistry.load(INDEX).get("ltx_i2v")
    spec.graph_path = str(bad)
    with pytest.raises(WorkflowError, match="Save \\(API format\\)"):
        load_graph(spec)
