# keyframes/

Drop your keyframe images here. The batch runner reads this folder directly.

## Naming rules

| file | required | purpose |
| --- | --- | --- |
| `scene01_start.png` | yes | first frame |
| `scene01_end.png` | no | last frame — presence switches the scene to first+last conditioning |
| `scene01_prompt.txt` | no | the prompt for this scene |
| `scene01_preset.txt` | no | one line: a preset name, overriding `--preset` for this scene |
| `scene01_negative.txt` | no | per-scene negative prompt |

`scene01.png` on its own also works and is treated as the start frame.
`_first` / `_last` are accepted as synonyms of `_start` / `_end`.
Accepted image extensions: `.png`, `.jpg`, `.jpeg`, `.webp`.

The scene id is whatever comes before the suffix, so `bedroom-morning_start.png`
produces `clips/bedroom-morning_v1.mp4`. Scenes run in sorted order.

## Example

```
keyframes/
  scene01_start.png
  scene01_end.png
  scene01_prompt.txt        "엄마가 창가에서 커피를 마시며 밖을 바라본다"
  scene01_preset.txt        calm
  scene02_start.png
  scene02_prompt.txt
  scene03_start.png         (no end frame — falls back to the single-frame workflow)
  scene03_prompt.txt
```

Then:

```bash
python -m pipeline.batch_generate --preset calm
```

produces `clips/scene01_v1.mp4`, `clips/scene02_v1.mp4`, `clips/scene03_v1.mp4`
plus a report under `clips/_reports/`.

Images themselves are gitignored — this is a private family project, so
keyframes and clips stay out of the repository.
