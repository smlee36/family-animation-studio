import os

import pytest
import yaml

from pipeline.presets import PresetError, PresetLibrary

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRESETS = os.path.join(ROOT, "config", "presets.yaml")


@pytest.fixture(scope="module")
def lib():
    return PresetLibrary.load(PRESETS)


def test_shipped_presets_all_resolve(lib):
    # Every preset in the repo must load and validate; a broken one would only
    # surface hours into an overnight run otherwise.
    assert set(lib.names()) >= {"calm", "action", "camera", "draft", "final_1080p"}


def test_phase2_deliverable_presets_are_distinct(lib):
    calm, action, camera = lib.get("calm"), lib.get("action"), lib.get("camera")
    # The three scene-type presets must actually differ on the motion dial,
    # otherwise the Phase 2 deliverable is cosmetic.
    shifts = {p.params["max_shift"] for p in (calm, action, camera)}
    assert len(shifts) == 3
    assert calm.params["max_shift"] < camera.params["max_shift"] <= action.params["max_shift"]
    for preset in (calm, action, camera):
        assert preset.label and preset.notes
        assert preset.prompt_suffix


def test_inheritance_merges_base(lib):
    calm = lib.get("calm")
    assert calm.params["width"] == 1280          # from base
    assert calm.params["cfg"] == 2.8             # overridden
    assert calm.workflow == "ltx_i2v_firstlast"  # from base


def test_multi_level_inheritance(lib):
    final = lib.get("final_1080p")
    assert final.workflow == "ltx_i2v_firstlast_post"
    assert final.params["max_shift"] == lib.get("action").params["max_shift"]  # via action
    assert final.params["out_width"] == 1920
    assert final.params["steps"] == 40


def test_drop_removes_inherited_keys(lib):
    wan = lib.get("wan_calm")
    # Wan's graph has no LTX scheduler; these must not be sent to it.
    for key in ("max_shift", "base_shift", "terminal", "guide_strength_start"):
        assert key not in wan.params
    assert wan.params["shift"] == 8.0
    assert wan.workflow == "wan_i2v"


def test_drop_survives_further_inheritance(lib):
    wan_action = lib.get("wan_action")
    assert "max_shift" not in wan_action.params
    assert wan_action.params["cfg"] == 5.5


def _write(tmp_path, doc):
    path = tmp_path / "p.yaml"
    path.write_text(yaml.safe_dump(doc), encoding="utf-8")
    return str(path)


def test_rejects_bad_frame_count(tmp_path):
    path = _write(tmp_path, {
        "base": {"workflow": "ltx_i2v", "length": 121},
        "presets": {"x": {"extends": "base", "length": 100}},
    })
    with pytest.raises(PresetError, match=r"nearest valid: 97"):
        PresetLibrary.load(path)


def test_rejects_non_multiple_of_32_dimension(tmp_path):
    path = _write(tmp_path, {
        "base": {"workflow": "ltx_i2v"},
        "presets": {"x": {"extends": "base", "width": 1281}},
    })
    with pytest.raises(PresetError, match="multiple of 32"):
        PresetLibrary.load(path)


def test_rejects_absurd_cfg(tmp_path):
    path = _write(tmp_path, {
        "base": {"workflow": "ltx_i2v"},
        "presets": {"x": {"extends": "base", "cfg": 500}},
    })
    with pytest.raises(PresetError, match="cfg"):
        PresetLibrary.load(path)


def test_detects_circular_extends(tmp_path):
    path = _write(tmp_path, {
        "base": {"workflow": "ltx_i2v"},
        "presets": {"a": {"extends": "b"}, "b": {"extends": "a"}},
    })
    with pytest.raises(PresetError, match="circular"):
        PresetLibrary.load(path)


def test_unknown_preset_lists_alternatives(lib):
    with pytest.raises(PresetError, match="Available:"):
        lib.get("does-not-exist")
