# Phase 8–12 운영 구조

## Phase 8 — 자동 영상 라우터

- Director가 각 Shot에 `motionProfile`을 저장합니다.
- 표정·작은 상체 동작은 LTX, 걷기·큰 자세 변화·여러 인물 접촉은 Wan을 추천합니다.
- `HYBRID_VIDEO_ROUTER_ENABLED=false`에서는 추천만 기록하고 LTX로 생성하는 Shadow Mode입니다.
- QC가 캐릭터, 손·신체, 움직임 점수를 낮게 주면 최대 2회 범위 안에서 Wan 재생성을 요청합니다.

## Phase 9 — Qwen Vision Director/QC

- B200의 OpenAI 호환 `/v1/chat/completions`에 텍스트와 이미지를 함께 전달합니다.
- JSON Schema 응답으로 Director Plan과 8개 QC 점수를 받습니다.
- GPU가 영상·이미지 모델로 전환되는 동안 Qwen이 내려가면 OpenAI Responses API로 자동 대체합니다.

## Phase 10 — Qwen Image Scene Frame

- `Qwen-Image-Edit-2511`에 최대 6개의 Master Reference와 Scene 프롬프트를 전달합니다.
- 결과는 기존과 동일하게 Private Vercel Blob에 저장됩니다.
- 모델이 준비되지 않았거나 작업이 실패하면 Gemini 이미지 모델로 자동 대체합니다.

## Phase 11 — B200 단일 GPU 스케줄러

- LTX, Wan, Qwen Image 생성은 하나의 GPU 실행 잠금으로 직렬화됩니다.
- 생성 전에 상시 Qwen 언어 모델 또는 LTX resident 모델을 안전하게 내립니다.
- 생성 후 이전 모드를 복구하며 실패 로그와 복구 경고를 작업 메타데이터에 남깁니다.
- LTX, Wan, Qwen Image는 각각 독립 대기열과 상태·결과 API를 가집니다.
- Wan 118GB 가중치는 `/NHNHOME/.family-animation-models`의 로컬 NVMe 캐시를 우선 사용해 네트워크 스토리지의 반복 로딩 병목을 피합니다.
- Wan은 B200 180GB에서 CPU offload를 끄고 실행하며, 16fps 기준 5초 81프레임·10초 161프레임으로 생성합니다.

## Phase 12 — 운영 전환

1. 모델 다운로드와 worker health 확인
2. Qwen Vision Director/QC를 먼저 활성화
3. Qwen Image 1장 검증 후 Scene 이미지 provider 전환
4. Wan 5초 1개 검증 후 Hybrid Router 활성화
5. Preview 배포에서 Story → Scene → Shot → 생성 → QC → 저장 → 병합 확인
6. Production 승격 후 모바일 Safari/Chrome 재검증

Feature Flag는 이 순서를 지키기 위해 기본적으로 안전한 값으로 유지합니다.

## 2026-08-18 검증 기록

- Qwen 3.8-27B: 텍스트·이미지 이해와 strict JSON Schema 응답 확인
- Qwen-Image-Edit-2511: 레퍼런스 1장으로 1664×928 이미지 생성 성공, 약 3분 14초
- Qwen 자동 복구: 이미지/Wan 작업 종료 후 `/v1/models` 200 응답 확인
- Production 모바일: 390×844에서 로그인, Episode 이력, Studio 자동 선택 UI 확인; 가로 overflow 없음
- Wan 2.2: 로컬 NVMe·GPU 상주 최적화 후 5초 실생성 검증 중이며, 성공 전까지 Hybrid Router는 Shadow Mode 유지
