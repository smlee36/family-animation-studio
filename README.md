# Family Animation Studio

부부가 함께 사용하는 비공개 가족 애니메이션 제작 웹앱입니다. 긴 가족 이야기를 입력하면 향후 Director가 `Story → Scene → Shot → Reference → Veo → QC → 최종 영상` 흐름을 자동으로 처리합니다.

## 현재 구현 상태

- Phase 1: Next.js App Router 구조, 가족 비밀번호 인증, 서버 환경변수 확인, 모바일 우선 Story 입력 UI
- Phase 2: Private Vercel Blob 기반 공동 Master Reference Library, 다중 업로드, 카테고리, 교체/삭제, 인증 이미지 스트리밍
- Phase 3: OpenAI Responses API 기반 `Story → Scene → Shot` Director, Storyboard 참고, Reference 자동 선택, Scene accordion 및 프롬프트 수정
- Phase 4: Veo 3.1 Fast 우선 Shot 생성, 공식 operation polling, Reference 전달, Private Blob 영상 보관 및 웹 재생/저장
- Phase 5: 대표 프레임 기반 GPT 영상 QC, 8개 품질 점수, 85점 미만 Standard 자동 보정(최대 2회), 자동/수동 승인
- Phase 6: 같은 Scene의 이전 Shot 마지막 프레임을 다음 Shot 시작 조건으로 전달
- Phase 7: Episode 저장·이력, 전체 Shot 순차 미리보기/이어하기, 승인 Shot 하드컷 MP4 병합·다운로드
- Phase 8: Shot 동작 난이도 자동 분류, LTX/Wan 자동 라우팅, QC 기반 모델 전환 및 안전한 Shadow Mode
- Phase 9: B200 Qwen 비전 기반 Director/QC 선택 경로, 구조화 JSON 출력, 장애 시 OpenAI 자동 대체
- Phase 10: 여러 Master Reference를 받는 Qwen-Image-Edit-2511 Scene 기준 이미지 경로와 Gemini 자동 대체
- Phase 11: B200의 Qwen 언어 모델, Qwen Image, LTX, Wan이 한 GPU를 순차 공유하는 잠금·대기열·자동 복구 스케줄러
- Phase 12: 통합 상태 확인, 모바일 자동 선택 UI, 운영 환경 Feature Flag와 전체 흐름 검증
- Photo 연결 모드: 사진 3장을 하나의 10초 생성 타임라인에서 시작·중간·끝 키프레임으로 고정해 장면 전환 없이 연속 동작으로 생성

## 로컬 실행

1. `.env.example`을 참고해 `.env.local`을 준비합니다.
2. `npm install`
3. `npm run dev`

필수 비밀값은 서버에서만 읽으며 `NEXT_PUBLIC_` 접두사를 사용하지 않습니다.

## 환경변수

- `FAMILY_STUDIO_PASSCODE`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `BLOB_READ_WRITE_TOKEN` (Phase 2, Vercel Blob 연결 시 자동 제공)
- `OPENAI_DIRECTOR_MODEL` (선택, 기본값 `gpt-5.6-terra`)
- `OPENAI_QC_MODEL` (선택, 기본값 `gpt-5.6-terra`)
- `GEMINI_VEO_FAST_MODEL` (선택, 기본값 `veo-3.1-fast-generate-preview`)
- `GEMINI_VEO_STANDARD_MODEL` (선택, 기본값 `veo-3.1-generate-preview`)
- `GEMINI_VEO_MODEL` (기존 Standard override 호환용)
- `QWEN_API_BASE`, `QWEN_API_KEY`, `QWEN_VISION_MODEL` (B200 OpenAI 호환 비전 API)
- `DIRECTOR_AI_PROVIDER`, `QC_AI_PROVIDER` (`openai` 또는 `qwen`)
- `WAN_API_BASE`, `WAN_API_KEY`, `HYBRID_VIDEO_ROUTER_ENABLED`
- `QWEN_IMAGE_API_BASE`, `QWEN_IMAGE_API_KEY`, `SCENE_IMAGE_PROVIDER`

현재 Vercel 연결은 `BLOB_STORE_ID`와 Vercel OIDC를 사용합니다. Private Blob OIDC가 Preview/Production에만 연결된 경우 로컬 Development에서는 Blob API 대신 Preview 배포에서 통합 테스트합니다.

## 품질 검사

```bash
npm run lint
npm run typecheck
npm run build
```

## B200 오픈 비디오 백엔드

Gemini/Veo를 대체할 오픈 비디오 백엔드는 LTX-2.5를 기준으로 구축 중입니다.
최종 모드는 Dev BF16 HQ 2단계 파이프라인, 초안 모드는 Distilled를 사용합니다.
설치 상태와 품질 프리셋은 [`gpu/ltx25`](gpu/ltx25/README.md)에 기록합니다.
고난도 전신 동작은 공식 Wan 2.2 I2V-A14B, 여러 레퍼런스로 Scene 이미지를 합성할 때는 Qwen-Image-Edit-2511을 사용합니다. 두 모델은 준비 완료 전 Feature Flag가 꺼져 있으며 기존 LTX/Gemini 경로가 계속 동작합니다.
Wan 모델은 B200 로컬 NVMe 캐시를 우선 사용합니다. 캐시를 다시 만들 때는 `gpu/wan22/cache-model-local.sh`를 tmux에서 실행합니다.
