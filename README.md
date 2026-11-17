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

무대 사용법(손짓·키·투표)은 `docs/GUIDE.md` 7절. 빈 곳 주먹 끌기나 두 주먹으로 지도를 지구본처럼 돌리고(빠르게 놓으면 관성, 다시 쥐면 멈춤) 두 주먹 벌리기·휠로 확대하며, 이 회전·확대는 큰 화면(`#/3d?stage=1`)만 따라옵니다.

```bash
mkdir -p frontend/public/models
curl -L -o frontend/public/models/gesture_recognizer.task \
  https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task
```

- 경로: `frontend/public/models/gesture_recognizer.task` (float16, 약 8MB)
- wasm은 `npm run dev`와 `npm run build` 전에 `node_modules`에서 `frontend/public/mediapipe/wasm/`으로 자동 복사됩니다(git 제외).
- 받은 파일이 zip(`PK` 시그니처)이 아니면 빌드 시 경고가 나옵니다(받다 만 파일이나 오류 페이지).

### 카메라와 외부 호출

- 모델 파일은 발표 전에 위 명령으로 한 번만 손으로 받습니다. 실행 중에는 모델·wasm을 모두 같은 출처(`/models/`, `/mediapipe/wasm/`)에서 읽고, Google을 포함한 외부 서버를 부르지 않습니다.
- 카메라 영상과 손 좌표는 노트북 브라우저 안에서만 처리됩니다. 실행 중 연결하는 곳은 같은 출처(CloudFront, 정적 파일 읽기)와 AppSync Events뿐이고, 밖으로 보내는 것은 상태 메시지(`/seoul/state`, `/seoul/stage`의 무대·투표 메시지)뿐입니다. 메시지에 손 좌표·영상은 들어 있지 않고, 회전 때문에 무대 메시지에 더해진 값은 돌린 각도·확대 배율(`yaw`·`zoom`) 두 숫자뿐입니다.
- `@mediapipe/tasks-vision`은 `0.10.35`로 고정합니다. 1.x 판은 인식기를 만들 때 사용 통계 로거를 조건 없이 켜고 1분마다 Google(`odml.pa.googleapis.com`)로 지연·횟수 통계를 보내며, 끄는 옵션이 없습니다. `npm run build`의 postbuild(`scripts/check-bundle.mjs`)가 빌드 산출물에 그 송신 코드가 있으면 빌드를 실패시킵니다. 판을 올릴 때는 이 검사를 통과해야 합니다.

## 해설 다시 만들기

저장소 루트에서 실행합니다. AWS 기본 자격 증명(us-east-1)을 쓰고 호출마다 요금이 듭니다(write = Bedrock, synth = Polly).

1. 문장 쓰기: `node tools/narration/write.mjs --data frontend/public/data --month 202611 --out tools/narration/scripts.json`
   - 기존 `scripts.json`과 병합합니다. `source: "edited"`(사람이 고친 문장)는 덮지 않고 그대로 두며, 현재 사실표와 맞지 않으면 경고합니다. 덮어쓰려면 `--force`.
   - 일부 구만 다시 쓰기: `--only 강남구,서초구`.
   - 자막 속 숫자와 최상급은 `validateScript`가 사실표와 맞춰 봅니다(순위, 억·만 원, 건수, "가장 …", 동은 "3건 이상" 단서 또는 구 전체 최고일 때만).
2. 사람이 검토: 고친 항목은 `source`를 `"edited"`로 바꾸고, `speech`는 caption과 같게 둡니다(㎡만 "제곱미터"). `cd tools && npx vitest run narration/shipped`로 실린 문장·manifest·mp3가 서로, 그리고 현재 데이터와 맞는지 확인합니다.
3. 음성 합성: `node tools/narration/synth.mjs --scripts tools/narration/scripts.json --data frontend/public/data --month 202611 --out frontend/public/narration`
   - 바뀐 문장만 다시 합성하고, 클립 길이(`ms`)를 manifest에 적습니다.
   - 이미 있는 mp3로 `ms`만 채우기(AWS 호출 없음): `node tools/narration/synth.mjs --backfill-ms --out frontend/public/narration`
   - 문장 목록에서 빠진 id의 mp3는 지우지 않습니다. 필요하면 손으로 정리합니다.
