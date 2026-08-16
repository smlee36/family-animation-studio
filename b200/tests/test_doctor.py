"""Tests for the workflow validator.

Note on what these prove: the mock's /object_info was written to match the
shipped graphs, so a clean run here does NOT mean the graphs match a real
ComfyUI install — only that the validator's plumbing works. The negative tests
are the important ones: they show the doctor actually catches a wrong node
class, a wrong input name and a wrong model filename.
"""

import json
import os

import pytest
import yaml

from pipeline import doctor
from pipeline.workflow import WorkflowRegistry

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "workflows", "index.yaml")


@pytest.fixture
def object_info(mock_server):
    from pipeline.comfy_client import ComfyClient

    return ComfyClient(mock_server.url).object_info()


def test_shipped_workflows_pass_against_the_mock(object_info):
    registry = WorkflowRegistry.load(INDEX)
    for name in registry.workflows:
        assert doctor.check_workflow(name, registry, object_info) == [], name


def _registry_with(tmp_path, graph, bindings=None):
    graph_path = tmp_path / "g.json"
    graph_path.write_text(json.dumps(graph), encoding="utf-8")
    index = tmp_path / "index.yaml"
    index.write_text(yaml.safe_dump({
        "version": 1,
        "workflows": {"t": {
            "graph": "g.json",
            "model": "ltx",
            "bindings": bindings or {},
            "output_title": "B200::output",
        }},
    }), encoding="utf-8")
    return WorkflowRegistry.load(str(index))


def test_detects_unknown_node_class_and_suggests_a_real_one(tmp_path, object_info):
    registry = _registry_with(tmp_path, {
        "1": {"class_type": "LTXVImageToVideo", "_meta": {"title": "B200::i2v"}, "inputs": {}},
    })
    problems = doctor.check_workflow("t", registry, object_info)
    assert len(problems) == 1
    assert "LTXVImageToVideo" in problems[0]
    # The real class is LTXVImgToVideo — the suggestion has to find it.
    assert "LTXVImgToVideo" in problems[0]


def test_detects_missing_custom_node_pack(tmp_path, object_info):
    registry = _registry_with(tmp_path, {
        "1": {"class_type": "TotallyMadeUpNode", "_meta": {"title": "x"}, "inputs": {}},
    })
    problems = doctor.check_workflow("t", registry, object_info)
    assert "custom node pack" in problems[0]


def test_detects_wrong_input_name_in_a_binding(tmp_path, object_info):
    registry = _registry_with(
        tmp_path,
        {"1": {"class_type": "CLIPTextEncode", "_meta": {"title": "B200::prompt"},
               "inputs": {"text": "", "clip": ["2", 0]}}},
        bindings={"prompt": [{"title": "B200::prompt", "input": "txt"}]},
    )
    problems = doctor.check_workflow("t", registry, object_info)
    assert any("does not exist" in p and "text" in p for p in problems)


def test_detects_binding_to_a_missing_title(tmp_path, object_info):
    registry = _registry_with(
        tmp_path,
        {"1": {"class_type": "CLIPTextEncode", "_meta": {"title": "B200::prompt"}, "inputs": {"text": ""}}},
        bindings={"prompt": [{"title": "B200::nope", "input": "text"}]},
    )
    problems = doctor.check_workflow("t", registry, object_info)
    assert any("no node has that title" in p for p in problems)


def test_detects_a_model_filename_the_server_does_not_have(tmp_path, object_info):
    registry = _registry_with(tmp_path, {
        "1": {"class_type": "CheckpointLoaderSimple", "_meta": {"title": "B200::checkpoint"},
              "inputs": {"ckpt_name": "ltx/ltx-2.5-does-not-exist.safetensors"}},
    })
    problems = doctor.check_workflow("t", registry, object_info)
    assert len(problems) == 1
    assert "not one of the server's choices" in problems[0]
    assert "ltx/ltxv.safetensors" in problems[0]


def test_wired_links_are_not_mistaken_for_bad_enum_values(tmp_path, object_info):
    registry = _registry_with(tmp_path, {
        "1": {"class_type": "CheckpointLoaderSimple", "_meta": {"title": "a"},
              "inputs": {"ckpt_name": "ltx/ltxv.safetensors"}},
        "2": {"class_type": "VAEDecode", "_meta": {"title": "b"},
              "inputs": {"samples": ["1", 0], "vae": ["1", 2]}},
    })
    assert doctor.check_workflow("t", registry, object_info) == []


def test_cli_reports_and_exits_non_zero_on_problems(tmp_path, mock_server, capsys):
    graph = {"1": {"class_type": "NopeNode", "_meta": {"title": "x"}, "inputs": {}}}
    (tmp_path / "g.json").write_text(json.dumps(graph), encoding="utf-8")
    (tmp_path / "index.yaml").write_text(yaml.safe_dump({
        "version": 1,
        "workflows": {"t": {"graph": "g.json", "model": "ltx", "bindings": {}}},
    }), encoding="utf-8")

    rc = doctor.main(["--url", mock_server.url, "--workflows-file", str(tmp_path / "index.yaml")])
    assert rc == 1
    assert "problem(s) found" in capsys.readouterr().out


def test_cli_passes_on_the_shipped_workflows(mock_server, capsys):
    rc = doctor.main(["--url", mock_server.url, "--workflows-file", INDEX])
    assert rc == 0
    assert "all workflows validate" in capsys.readouterr().out


def test_cli_list_nodes(mock_server, capsys):
    rc = doctor.main(["--url", mock_server.url, "--list-nodes", "ltx"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "LTXVImgToVideo" in out and "LTXVAddGuide" in out


def test_cli_unreachable_server(capsys):
    rc = doctor.main(["--url", "http://127.0.0.1:1"])
    assert rc == 2
    assert "cannot reach ComfyUI" in capsys.readouterr().err
