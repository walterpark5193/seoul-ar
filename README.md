# 서울이 선다 (seoul-ar)

폰 카메라로 발표 화면의 그림을 비추면 그림 위에 서울 25개 자치구와 법정동 실거래 막대가 3D로 서고,
발표자의 선택이 모든 폰에 실시간으로 반영되는 웹앱. AWS 캡스톤 자유 프로젝트.

- 설계: `docs/superpowers/specs/2026-11-17-seoul-ar-design.md`
- 모듈 계약: `docs/CONTRACTS.md`
- 계획: `docs/superpowers/plans/2026-11-17-seoul-ar.md`
- `tools/` 데이터 집계, 지오 변환, 마커 생성 (Node 24, vitest)
- `frontend/` Vite + TypeScript + three + mind-ar + aws-amplify(events)
- `infra/` CDK(JS) us-east-1: S3 비공개 + CloudFront OAC + AppSync Events

## 무대 모델 받기

`#/stage`의 손 인식은 MediaPipe GestureRecognizer 모델 파일 하나가 필요합니다. 용량 때문에 git에는 없고(`frontend/public/models/`는 제외), 직접 한 번 받습니다. 없으면 무대는 마우스 모드로만 동작합니다.

```bash
mkdir -p frontend/public/models
curl -L -o frontend/public/models/gesture_recognizer.task \
  https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task
```

- 경로: `frontend/public/models/gesture_recognizer.task` (float16, 약 8MB)
- wasm은 `npm run dev`와 `npm run build` 전에 `node_modules`에서 `frontend/public/mediapipe/wasm/`으로 자동 복사됩니다(git 제외).
- 받은 파일이 zip(`PK` 시그니처)이 아니면 빌드 시 경고가 나옵니다(받다 만 파일이나 오류 페이지).
