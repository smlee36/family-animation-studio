"""End-to-end batch runs against the mock ComfyUI server.

This is the Phase 3 completion condition, exercised without a GPU: three
keyframe scenes in, three clips out, plus the failure/retry/report behaviour
that an unattended overnight run depends on.
"""

import json
import os

from pipeline import batch_generate
from pipeline.comfy_client import ComfyClient


def run(argv):
    return batch_generate.main(argv)


def base_args(keyframes, clips, url, *extra):
    return [
        "--keyframes", str(keyframes),
        "--clips", str(clips),
        "--url", url,
        "--retries", "0",
        "--seed", "1000",
        *extra,
    ]


def clip_files(clips):
    return sorted(f for f in os.listdir(clips) if f.endswith(".mp4"))


def latest_report(clips):
    report_dir = os.path.join(clips, "_reports")
    files = sorted(f for f in os.listdir(report_dir) if f.endswith(".json"))
    with open(os.path.join(report_dir, files[-1])) as fh:
        return json.load(fh)


# --------------------------------------------------------------- happy path
def test_three_keyframe_scenes_produce_three_clips(keyframes, clips, mock_server):
    rc = run(base_args(keyframes, clips, mock_server.url))
    assert rc == 0

    assert clip_files(clips) == ["scene01_v1.mp4", "scene02_v1.mp4", "scene03_v1.mp4"]
    for name in clip_files(clips):
        assert os.path.getsize(os.path.join(clips, name)) > 0

    report = latest_report(clips)
    assert report["summary"] == {"total": 3, "ok": 3, "failed": 0, "skipped": 0,
                                 "wall_time_s": report["summary"]["wall_time_s"]}
    assert {r["scene_id"] for r in report["results"]} == {"scene01", "scene02", "scene03"}
    assert all(r["seed"] is not None for r in report["results"])


def test_markdown_report_is_written(keyframes, clips, mock_server):
    run(base_args(keyframes, clips, mock_server.url))
    report_dir = os.path.join(clips, "_reports")
    md = [f for f in os.listdir(report_dir) if f.endswith(".md")]
    assert md
    text = open(os.path.join(report_dir, md[0]), encoding="utf-8").read()
    assert "Batch generation report" in text
    assert "scene01" in text
    assert "3 ok / 0 failed" in text


def test_scene_without_end_frame_falls_back_to_single_frame_workflow(keyframes, clips, mock_server):
    run(base_args(keyframes, clips, mock_server.url))
    report = latest_report(clips)
    by_id = {r["scene_id"]: r for r in report["results"]}
    # scene01/02 have both frames; scene03 has only a start frame.
    assert by_id["scene01"]["workflow"] == "ltx_i2v_firstlast"
    assert by_id["scene03"]["workflow"] == "ltx_i2v"
    assert by_id["scene03"]["status"] == "ok"


def test_prompt_and_suffix_reach_the_graph(keyframes, clips, mock_server):
    run(base_args(keyframes, clips, mock_server.url, "--preset", "calm", "--scenes", "scene01"))
    graph = mock_server.state.prompts[0]["graph"]
    prompt_node = next(n for n in graph.values() if n["_meta"]["title"] == "B200::prompt")
    text = prompt_node["inputs"]["text"]
    assert "a watercolour illustration, scene01" in text
    assert "gentle breathing" in text  # calm's prompt_suffix was appended


def test_preset_values_reach_the_graph(keyframes, clips, mock_server):
    run(base_args(keyframes, clips, mock_server.url, "--preset", "action", "--scenes", "scene01"))
    graph = mock_server.state.prompts[0]["graph"]
    by_title = {n["_meta"]["title"]: n for n in graph.values()}
    assert by_title["B200::scheduler"]["inputs"]["steps"] == 36
    assert by_title["B200::scheduler"]["inputs"]["max_shift"] == 2.60
    assert by_title["B200::sampler"]["inputs"]["cfg"] == 3.2
    assert by_title["B200::guide_end"]["inputs"]["strength"] == 0.88


def test_per_scene_preset_sidecar_overrides_the_flag(keyframes, clips, mock_server):
    (keyframes / "scene01_preset.txt").write_text("camera\n", encoding="utf-8")
    run(base_args(keyframes, clips, mock_server.url, "--preset", "calm", "--scenes", "scene01"))
    report = latest_report(clips)
    assert report["results"][0]["preset"] == "camera"


def test_both_keyframes_are_uploaded(keyframes, clips, mock_server):
    run(base_args(keyframes, clips, mock_server.url, "--scenes", "scene01"))
    names = [u.rsplit("/", 1)[-1] for u in mock_server.state.uploads]
    assert "scene01_start.png" in names
    assert "scene01_end.png" in names


# ----------------------------------------------------------------- versioning
def test_regeneration_writes_v2_not_overwriting_v1(keyframes, clips, mock_server):
    run(base_args(keyframes, clips, mock_server.url, "--scenes", "scene01"))
    first = open(os.path.join(clips, "scene01_v1.mp4"), "rb").read()

    run(base_args(keyframes, clips, mock_server.url, "--scenes", "scene01"))
    assert clip_files(clips) == ["scene01_v1.mp4", "scene01_v2.mp4"]
    assert open(os.path.join(clips, "scene01_v1.mp4"), "rb").read() == first


def test_skip_existing(keyframes, clips, mock_server):
    run(base_args(keyframes, clips, mock_server.url, "--scenes", "scene01"))
    run(base_args(keyframes, clips, mock_server.url, "--scenes", "scene01", "--skip-existing"))
    assert clip_files(clips) == ["scene01_v1.mp4"]
    assert latest_report(clips)["summary"]["skipped"] == 1


# ------------------------------------------------------- failure and recovery
def test_failure_does_not_stop_the_run(keyframes, clips, mock_server):
    # Fail exactly the first scene's only attempt.
    mock_server.state.fail_times = 1
    rc = run(base_args(keyframes, clips, mock_server.url))

    assert rc == 1  # non-zero because something failed
    report = latest_report(clips)
    assert report["summary"] == {**report["summary"], "ok": 2, "failed": 1}
    # The remaining scenes still ran — this is the overnight requirement.
    assert clip_files(clips) == ["scene02_v1.mp4", "scene03_v1.mp4"]

    failed = next(r for r in report["results"] if r["status"] == "failed")
    assert "CUDA out of memory" in failed["error"]


def test_retry_recovers_a_transient_failure(keyframes, clips, mock_server):
    mock_server.state.fail_times = 1
    rc = run([
        "--keyframes", str(keyframes), "--clips", str(clips), "--url", mock_server.url,
        "--scenes", "scene01", "--retries", "1", "--seed", "7",
    ])
    assert rc == 0
    assert clip_files(clips) == ["scene01_v1.mp4"]
    report = latest_report(clips)
    assert report["results"][0]["attempts"] == 2


def test_reseed_on_retry_changes_the_seed(keyframes, clips, mock_server):
    mock_server.state.fail_times = 1
    run([
        "--keyframes", str(keyframes), "--clips", str(clips), "--url", mock_server.url,
        "--scenes", "scene01", "--retries", "1", "--seed", "7", "--reseed-on-retry",
    ])
    graphs = mock_server.state.prompts
    seeds = [
        next(n for n in g["graph"].values() if n["_meta"]["title"] == "B200::sampler")["inputs"]["noise_seed"]
        for g in graphs
    ]
    assert len(seeds) == 2 and seeds[0] != seeds[1]


def test_stop_on_error_aborts(keyframes, clips, mock_server):
    mock_server.state.fail_times = 1
    run(base_args(keyframes, clips, mock_server.url, "--stop-on-error"))
    report = latest_report(clips)
    assert report["summary"]["total"] == 1
    assert report["summary"]["failed"] == 1


def test_run_finishing_without_a_video_is_reported_as_failure(keyframes, clips, mock_server):
    mock_server.state.produce_output = False
    rc = run(base_args(keyframes, clips, mock_server.url, "--scenes", "scene01"))
    assert rc == 1
    failed = latest_report(clips)["results"][0]
    assert "produced no video file" in failed["error"]


def test_validation_error_is_surfaced_with_node_detail(keyframes, clips, mock_server):
    mock_server.state.reject_next = True
    rc = run(base_args(keyframes, clips, mock_server.url, "--scenes", "scene01"))
    assert rc == 1
    err = latest_report(clips)["results"][0]["error"]
    assert "CheckpointLoaderSimple" in err
    assert "not in list" in err


def test_unreachable_server_exits_cleanly(keyframes, clips):
    rc = run(base_args(keyframes, clips, "http://127.0.0.1:1", "--connect-timeout", "1"))
    assert rc == 1


# ----------------------------------------------------------------- other modes
def test_dry_run_generates_nothing(keyframes, clips, mock_server):
    rc = run(base_args(keyframes, clips, mock_server.url, "--dry-run"))
    assert rc == 0
    assert clip_files(clips) == []
    assert mock_server.state.prompts == []
    assert latest_report(clips)["summary"]["skipped"] == 3


def test_scene_filter(keyframes, clips, mock_server):
    run(base_args(keyframes, clips, mock_server.url, "--scenes", "scene02"))
    assert clip_files(clips) == ["scene02_v1.mp4"]


def test_list_presets(capsys):
    assert run(["--list-presets"]) == 0
    out = capsys.readouterr().out
    assert "calm" in out and "action" in out and "camera" in out


# -------------------------------------------------------- Phase 4: model swap
def test_model_flag_selects_the_wan_workflow(keyframes, clips, mock_server):
    rc = run(base_args(keyframes, clips, mock_server.url, "--model", "wan",
                       "--preset", "calm", "--scenes", "scene01"))
    assert rc == 0
    report = latest_report(clips)
    assert report["results"][0]["preset"] == "wan_calm"
    assert report["results"][0]["workflow"] == "wan_i2v"

    graph = mock_server.state.prompts[0]["graph"]
    classes = {n["class_type"] for n in graph.values()}
    assert "WanImageToVideo" in classes
    # LTX-only knobs must not have leaked into the Wan graph.
    assert "LTXVScheduler" not in classes


def test_compare_writes_per_model_folders(keyframes, clips, mock_server):
    rc = run(base_args(keyframes, clips, mock_server.url, "--compare", "ltx,wan", "--scenes", "scene01"))
    assert rc == 0
    assert os.path.exists(os.path.join(clips, "ltx", "scene01_v1.mp4"))
    assert os.path.exists(os.path.join(clips, "wan", "scene01_v1.mp4"))


def test_client_reports_vram(mock_server):
    client = ComfyClient(mock_server.url)
    assert "B200" in client.vram_summary()
