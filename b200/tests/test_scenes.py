import pytest

from pipeline import scenes as scenes_mod
from tests.conftest import PNG_1PX


def test_discovers_start_end_and_prompt(keyframes):
    found = scenes_mod.discover(str(keyframes))
    assert [s.scene_id for s in found] == ["scene01", "scene02", "scene03"]

    s1 = found[0]
    assert s1.has_end
    assert s1.prompt == "a watercolour illustration, scene01"

    s3 = found[2]
    assert not s3.has_end
    assert s3.image_end is None


def test_bare_image_counts_as_start(tmp_path):
    d = tmp_path / "kf"
    d.mkdir()
    (d / "shot.png").write_bytes(PNG_1PX)
    found = scenes_mod.discover(str(d))
    assert len(found) == 1
    assert found[0].scene_id == "shot"
    assert found[0].image_start.endswith("shot.png")


def test_first_last_aliases(tmp_path):
    d = tmp_path / "kf"
    d.mkdir()
    (d / "a_first.png").write_bytes(PNG_1PX)
    (d / "a_last.png").write_bytes(PNG_1PX)
    found = scenes_mod.discover(str(d))
    assert found[0].has_end


def test_end_without_start_is_an_error(tmp_path):
    d = tmp_path / "kf"
    d.mkdir()
    (d / "orphan_end.png").write_bytes(PNG_1PX)
    with pytest.raises(scenes_mod.SceneError, match="end frame without a start frame"):
        scenes_mod.discover(str(d))


def test_duplicate_role_is_an_error(tmp_path):
    d = tmp_path / "kf"
    d.mkdir()
    (d / "dup_start.png").write_bytes(PNG_1PX)
    (d / "dup_start.jpg").write_bytes(PNG_1PX)
    with pytest.raises(scenes_mod.SceneError, match="two start frames"):
        scenes_mod.discover(str(d))


def test_only_filter(keyframes):
    found = scenes_mod.discover(str(keyframes), only=["scene02"])
    assert [s.scene_id for s in found] == ["scene02"]


def test_only_filter_rejects_unknown_scene(keyframes):
    with pytest.raises(scenes_mod.SceneError, match="not found"):
        scenes_mod.discover(str(keyframes), only=["nope"])


def test_per_scene_preset_sidecar(keyframes):
    (keyframes / "scene01_preset.txt").write_text("action\n", encoding="utf-8")
    found = scenes_mod.discover(str(keyframes))
    assert found[0].preset == "action"
    assert found[1].preset is None


def test_versioning_increments(clips):
    version, path = scenes_mod.next_version(str(clips), "scene01")
    assert version == 1 and path.endswith("scene01_v1.mp4")

    open(path, "wb").close()
    version, path = scenes_mod.next_version(str(clips), "scene01")
    assert version == 2 and path.endswith("scene01_v2.mp4")


def test_versioning_is_per_scene_and_not_prefix_confused(clips):
    # scene01 must not be bumped by a file belonging to scene010.
    (clips / "scene010_v7.mp4").write_bytes(b"")
    version, _ = scenes_mod.next_version(str(clips), "scene01")
    assert version == 1


def test_existing_versions(clips):
    (clips / "scene01_v1.mp4").write_bytes(b"")
    (clips / "scene01_v2.mp4").write_bytes(b"")
    (clips / "scene02_v1.mp4").write_bytes(b"")
    got = scenes_mod.existing_versions(str(clips), "scene01")
    assert [p.rsplit("/", 1)[-1] for p in got] == ["scene01_v1.mp4", "scene01_v2.mp4"]
