import json
import os

import pytest

from pipeline import sweep
from pipeline.testimage import write_png


@pytest.fixture
def image(tmp_path):
    return write_png(str(tmp_path / "start.png"), width=64, height=64)


def test_parse_axis_types():
    assert sweep.parse_axis("steps=20,30") == ("steps", [20, 30])
    assert sweep.parse_axis("cfg=2.5,3.0") == ("cfg", [2.5, 3.0])
    assert sweep.parse_axis("sampler_name=euler,dpmpp_2m") == ("sampler_name", ["euler", "dpmpp_2m"])


def test_parse_axis_rejects_garbage():
    import argparse

    with pytest.raises(argparse.ArgumentTypeError):
        sweep.parse_axis("nonsense")


def test_sweep_generates_the_full_grid(image, tmp_path, mock_server):
    out = tmp_path / "sweep"
    rc = sweep.main([
        "--image", image, "--url", mock_server.url, "--out", str(out),
        "--axis", "steps=20,30", "--axis", "cfg=2.5,3.0",
        "--prompt", "a watercolour room",
    ])
    assert rc == 0

    clips = sorted(f for f in os.listdir(out) if f.endswith(".mp4"))
    assert clips == [
        "steps20_cfg2p5.mp4", "steps20_cfg3p0.mp4",
        "steps30_cfg2p5.mp4", "steps30_cfg3p0.mp4",
    ]

    manifest = json.loads((out / "sweep.json").read_text())
    assert len(manifest["runs"]) == 4
    assert all(r["status"] == "ok" for r in manifest["runs"])
    # A sweep is only meaningful if the seed is held constant across the grid.
    assert manifest["seed"] == 1234

    index = (out / "index.md").read_text()
    assert "| steps | cfg | time | clip |" in index
    assert "steps30_cfg3p0.mp4" in index


def test_axis_values_actually_reach_the_graph(image, tmp_path, mock_server):
    sweep.main([
        "--image", image, "--url", mock_server.url, "--out", str(tmp_path / "s"),
        "--axis", "steps=17", "--axis", "cfg=4.25",
    ])
    graph = mock_server.state.prompts[0]["graph"]
    by_title = {n["_meta"]["title"]: n for n in graph.values()}
    assert by_title["B200::scheduler"]["inputs"]["steps"] == 17
    assert by_title["B200::sampler"]["inputs"]["cfg"] == 4.25


def test_unbindable_axis_is_rejected_before_generating(image, tmp_path, mock_server, capsys):
    rc = sweep.main([
        "--image", image, "--url", mock_server.url, "--out", str(tmp_path / "s"),
        "--axis", "not_a_param=1,2",
    ])
    assert rc == 2
    assert "no binding for axis" in capsys.readouterr().err
    assert mock_server.state.prompts == []


def test_max_runs_guard(image, tmp_path, mock_server, capsys):
    rc = sweep.main([
        "--image", image, "--url", mock_server.url, "--out", str(tmp_path / "s"),
        "--axis", "steps=1,2,3,4,5", "--axis", "cfg=1,2,3,4,5",
        "--max-runs", "10",
    ])
    assert rc == 2
    assert "over --max-runs" in capsys.readouterr().err


def test_falls_back_to_single_frame_workflow_without_end_image(image, tmp_path, mock_server, capsys):
    rc = sweep.main([
        "--image", image, "--url", mock_server.url, "--out", str(tmp_path / "s"),
        "--base-preset", "calm", "--axis", "steps=20",
    ])
    assert rc == 0
    assert "sweeping with 'ltx_i2v'" in capsys.readouterr().out
    classes = {n["class_type"] for n in mock_server.state.prompts[0]["graph"].values()}
    assert "LTXVAddGuide" not in classes


def test_uses_first_last_workflow_when_end_image_given(image, tmp_path, mock_server):
    rc = sweep.main([
        "--image", image, "--image-end", image, "--url", mock_server.url,
        "--out", str(tmp_path / "s"), "--axis", "steps=20",
    ])
    assert rc == 0
    classes = {n["class_type"] for n in mock_server.state.prompts[0]["graph"].values()}
    assert "LTXVAddGuide" in classes


def test_prompt_can_be_a_file(image, tmp_path, mock_server):
    ptxt = tmp_path / "p.txt"
    ptxt.write_text("from a file", encoding="utf-8")
    sweep.main([
        "--image", image, "--url", mock_server.url, "--out", str(tmp_path / "s"),
        "--axis", "steps=20", "--prompt", str(ptxt),
    ])
    graph = mock_server.state.prompts[0]["graph"]
    text = next(n for n in graph.values() if n["_meta"]["title"] == "B200::prompt")["inputs"]["text"]
    assert text.startswith("from a file")


def test_dry_run_generates_nothing(image, tmp_path, mock_server):
    rc = sweep.main([
        "--image", image, "--url", mock_server.url, "--out", str(tmp_path / "s"),
        "--axis", "steps=20,30", "--dry-run",
    ])
    assert rc == 0
    assert mock_server.state.prompts == []


def test_failure_is_recorded_but_the_grid_continues(image, tmp_path, mock_server):
    mock_server.state.fail_times = 1
    out = tmp_path / "s"
    rc = sweep.main([
        "--image", image, "--url", mock_server.url, "--out", str(out),
        "--axis", "steps=20,30",
    ])
    assert rc == 1
    manifest = json.loads((out / "sweep.json").read_text())
    statuses = [r["status"] for r in manifest["runs"]]
    assert statuses == ["failed", "ok"]
    assert "CUDA out of memory" in manifest["runs"][0]["error"]


def test_testimage_writes_a_real_png(tmp_path):
    path = write_png(str(tmp_path / "x.png"), width=32, height=16)
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    # IHDR carries the dimensions we asked for.
    assert int.from_bytes(data[16:20], "big") == 32
    assert int.from_bytes(data[20:24], "big") == 16
