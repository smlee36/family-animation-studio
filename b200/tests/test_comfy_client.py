import os

import pytest

from pipeline.comfy_client import ComfyClient, ComfyError, ExecutionTimeout, OutputFile
from tests.conftest import PNG_1PX


def test_ping_and_stats(mock_server):
    client = ComfyClient(mock_server.url)
    assert client.ping()
    assert client.system_stats()["devices"][0]["vram_total"] > 0


def test_ping_false_on_dead_server():
    assert ComfyClient("http://127.0.0.1:1").ping() is False


def test_wait_until_ready_times_out():
    with pytest.raises(ComfyError, match="not ready"):
        ComfyClient("http://127.0.0.1:1").wait_until_ready(timeout=1, interval=0.2)


def test_upload_returns_subfolder_qualified_name(mock_server, tmp_path):
    img = tmp_path / "frame.png"
    img.write_bytes(PNG_1PX)
    client = ComfyClient(mock_server.url)
    ref = client.upload_image(str(img))
    assert ref == "b200/frame.png"
    assert os.path.exists(os.path.join(mock_server.state.input_dir, "b200", "frame.png"))


def test_object_info_lists_nodes(mock_server):
    nodes = ComfyClient(mock_server.url).available_nodes()
    assert "LTXVAddGuide" in nodes and "VHS_VideoCombine" in nodes


def test_queue_rejects_unknown_node_class(mock_server):
    client = ComfyClient(mock_server.url)
    with pytest.raises(Exception, match="unknown node class"):
        client.queue_prompt({"1": {"class_type": "Bogus", "inputs": {}}})


def test_timeout_raises_and_interrupts(mock_server):
    mock_server.state.exec_delay = 30  # longer than the wait below
    client = ComfyClient(mock_server.url)
    prompt_id = client.queue_prompt({
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ltx/ltxv.safetensors"}},
    })
    with pytest.raises(ExecutionTimeout, match="exceeded 1s"):
        client.wait(prompt_id, timeout=1, poll_interval=0.2)


def test_collect_outputs_flattens_every_node_and_kind():
    entry = {"outputs": {
        "12": {"gifs": [{"filename": "a.mp4", "subfolder": "b200", "type": "output"}]},
        "13": {"images": [
            {"filename": "b.png", "subfolder": "", "type": "output"},
            {"filename": "c.png", "subfolder": "", "type": "output"},
        ]},
        "14": {"text": ["not a file dict"]},
    }}
    found = ComfyClient.collect_outputs(entry)
    assert sorted(o.filename for o in found) == ["a.mp4", "b.png", "c.png"]
    assert {o.kind for o in found} == {"gifs", "images"}


def test_collect_outputs_on_empty_entry():
    assert ComfyClient.collect_outputs({"outputs": {}}) == []
    assert ComfyClient.collect_outputs({}) == []


def test_download_writes_the_file(mock_server, tmp_path):
    out_dir = os.path.join(mock_server.state.output_dir, "b200")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "x.mp4"), "wb") as fh:
        fh.write(b"payload")

    dest = tmp_path / "got.mp4"
    ComfyClient(mock_server.url).download(
        OutputFile("x.mp4", "b200", "output", "12", "gifs"), str(dest)
    )
    assert dest.read_bytes() == b"payload"


def test_download_missing_file_raises(mock_server, tmp_path):
    with pytest.raises(ComfyError):
        ComfyClient(mock_server.url).download(
            OutputFile("nope.mp4", "", "output", "1", "gifs"), str(tmp_path / "x.mp4")
        )
