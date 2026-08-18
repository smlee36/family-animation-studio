# LTX-2.5 B200 video backend

Family Animation Studio의 키프레임 이미지를 영상으로 변환하는 B200 백엔드다.
최종 품질은 LTX-2.5 Dev BF16과 HQ 2단계 파이프라인을 우선하고,
Distilled 모델은 초안과 빠른 재시도에만 사용한다.

## 품질 원칙

- 한 Shot에는 한 가지 주요 행동만 넣는다.
- 인물, 의상, 배경, 소품은 승인된 시작 키프레임에 고정한다.
- 연결 Shot에는 이전 Shot의 마지막 프레임을 다음 시작 키프레임으로 사용한다.
- 끝 상태가 중요한 Shot은 시작/끝 키프레임 보간을 사용한다.
- 최종 출력은 BF16 Dev, HQ 2단계, 공간 업스케일을 기본으로 한다.
- 세로 릴스는 576x1024에서 생성해 1152x2048로 2배 업스케일한 뒤
  1080x1920으로 중앙 크롭한다.
- 5초 Shot은 24fps, 121프레임(`8*k+1`)을 사용한다.

## 서버 경로

```text
/NHNHOME/WORKSPACE/26mss002_U1A/ltx25/
  LTX-2/
  ComfyUI/
  models/
  input/
  outputs/
  logs/
```

토큰은 저장소에 기록하지 않는다. B200의 기존 Hugging Face credential
store를 `HF_HOME`으로 지정한다.

## Phase 1 상태

- Hugging Face 이용조건 승인 및 공식 BF16 가중치 7개 다운로드 완료
- 공식 HQ 2단계 I2V로 1280x704, 5.04초 테스트 영상 생성 완료
- ComfyUI 0.33.0과 LTX 전용 노드 81개 로드 완료
- ComfyUI GUI와 API는 포트 `8188`에서 실행
- 프리셋은 Phase 2 A/B 테스트 전까지 provisional 상태

실측 결과와 호환성 결정은 [`NOTES.md`](NOTES.md)에 기록한다.

## ComfyUI 실행 및 접속

```bash
./gpu/ltx25/start-comfy.sh
ssh -N -L 8188:127.0.0.1:8188 technode-b200
```

터널을 유지한 상태에서 `http://127.0.0.1:8188`을 연다. 공식 I2V 예시는
[`workflows/LTX-2.5_T2V_I2V_Two_Stage_Distilled.json`](workflows/LTX-2.5_T2V_I2V_Two_Stage_Distilled.json)을
ComfyUI에 드래그해 불러온다.

## Family Animation Studio API worker

사이트는 `worker/app.py`의 인증된 작업 API를 사용한다. 요청 즉시
`jobs/<generation-id>/job.json`을 기록하고 단일 큐에서 LTX를 실행하므로 브라우저나
Vercel 요청이 종료되어도 생성은 계속된다. 완성 MP4는 사이트가 다시 받아 Private
Vercel Blob에 영구 저장한다.

같은 worker는 Episode 최종 영상 병합도 담당한다. Vercel이 승인된 Shot의
단기 서명 URL을 `/merges`에 전달하면 각 클립을 동일 해상도·24fps·AAC로
정규화하고 Scene/Shot 순서대로 하드컷 MP4를 만든다. 완성본은 Vercel Blob에
다시 저장되므로 worker 디스크는 임시 작업 공간으로만 사용한다.

사진 3장 연결 모드는 공식 다중 `--image PATH FRAME_IDX STRENGTH` conditioning으로
사진 1→2와 사진 2→3의 5초 연결 장면을 각각 만든다. 두 장면 모두 시작과 끝 이미지를
강도 1.0으로 고정하고, 동일한 사진 2 프레임에서 hard cut으로 이어 정확히 10초로 만든다.
세 사진을 하나의 diffusion 타임라인에 동시에 넣으면 구도 차이가 큰 구간에서 프레임
스냅이나 인물 복제가 발생할 수 있으므로 기본 연결 모드에서는 사용하지 않는다.

정렬이 비슷하고 포즈 차이가 작은 키프레임은 Comfy 공식 FILM 모델과
`worker/interpolate_keyframes.py`로 보간할 수 있다. 이 경로는 프레임 점프 없이
24fps H.264/AAC MP4를 출력한다. 카메라 위치나 배경 구도가 크게 다른 이미지를 FILM으로
연결하면 인물과 배경이 휘거나 녹을 수 있으므로 사용하지 않는다. 이 경우에는 각 이미지를
독립적인 LTX Shot으로 움직인 뒤, 행동이 이어지는 지점에서 짧은 wipe 또는 hard cut으로
편집한다.

사이트의 기본 흐름은 `빠른 미리보기 → 확인 → 고화질 생성`이다. 새 Shot 길이는
5초 또는 10초만 사용한다. 미리보기는
448x768(세로) 또는 768x448(가로), 8단계로 만들며 최종본은 기존 HQ 프리셋을
사용한다. 여러 영상을 만들 때 고속 배치 모드를 켜면 대기 중인 Qwen을 잠시 중단하고 LTX
파이프라인을 GPU에 상주시킨다. 작업이 10분간 없거나 사용자가 모드를 끄면 LTX를
내리고 Qwen `/v1/models`가 실제 응답할 때까지 자동 복구 상태를 유지한다.

외부 주소는 기존 Cloudflare Tunnel의 `/ltx/*` 경로만 워커로 분기한다. `/v1/*`의
기존 LLM API는 그대로 유지한다. API 토큰은 B200의 `.ltx_api_token`과 Vercel의
`LTX_API_KEY`에만 저장하며 저장소에는 넣지 않는다.

```bash
ssh technode-b200 '/NHNHOME/WORKSPACE/26mss002_U1A/ltx25/project-config/worker/start-worker.sh'
ssh technode-b200 'tmux attach -t ltx25-worker'
```
