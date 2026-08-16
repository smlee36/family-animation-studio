import os
import sys

import pytest

# Make `pipeline` and `tests` importable when pytest is run from anywhere.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from tests.mock_comfyui import MockComfyServer  # noqa: E402

PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d4944415478da63f8ffff3f0005fe02fea735c9d200"
    "00000049454e44ae426082"
)


@pytest.fixture
def mock_server():
    with MockComfyServer() as server:
        yield server


@pytest.fixture
def keyframes(tmp_path):
    """Three scenes: two with start+end frames, one start-only."""
    d = tmp_path / "keyframes"
    d.mkdir()
    for scene in ("scene01", "scene02"):
        (d / f"{scene}_start.png").write_bytes(PNG_1PX)
        (d / f"{scene}_end.png").write_bytes(PNG_1PX)
        (d / f"{scene}_prompt.txt").write_text(f"a watercolour illustration, {scene}", encoding="utf-8")
    (d / "scene03_start.png").write_bytes(PNG_1PX)
    (d / "scene03_prompt.txt").write_text("a watercolour illustration, scene03", encoding="utf-8")
    return d


@pytest.fixture
def clips(tmp_path):
    d = tmp_path / "clips"
    d.mkdir()
    return d
