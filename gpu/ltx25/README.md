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
