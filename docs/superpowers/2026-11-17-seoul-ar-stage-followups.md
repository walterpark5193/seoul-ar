# #/stage 후속 메모 (2026-11-17)

브랜치 `feat/stage`(워크트리 `~/claude-lab/seoul-ar-stage`). 설계·계획·계약은 `docs/superpowers/specs/2026-11-17-seoul-ar-stage-design.md`, `docs/superpowers/plans/2026-11-17-seoul-ar-stage.md`, `docs/CONTRACTS-stage.md`(11절이 최종 수정 반영).

## 상태
- 계획 21개 작업 + 최종 리뷰 수정 전부 완료, 작업별 리뷰·재리뷰·최종 리뷰(4영역)·수정 재리뷰 통과.
- 검증: frontend 544 tests, tsc 0, build + `check-bundle`(사용 통계 엔드포인트 차단) 통과, tools 138, infra 6. 해설 229클립(manifest ms 포함).
- 브라우저 확인은 하지 않음(이 EC2에 브라우저 없음). 아래 리허설 목록으로 확인.

## 병합 전 할 일
1. 모델 받기: README "무대 모델 받기" 절 → `frontend/public/models/gesture_recognizer.task`.
2. main 최신(4eaf110 이후)과 병합: `main.ts`, `views/arView.ts`(+test), `tools/package*.json`에서 충돌 예상. `realtime.subscribe` 분기에 `|| route === "stage"` 유지, 무대는 `ctx.index`를 늦게 읽기.
3. 본체 세션에 알림: 무대는 새 채널 `/seoul/stage`를 쓰므로 Task 8 권한 부여자가 `seoul` 네임스페이스 전체 발행을 허용해야 하고, `#/stage`도 발표자 암호를 써야 함.

## 남은 위험 (수정 제안, 각 1~2줄)
- 미리보기 "숨김"(C 3회)이 `display:none`이면 일부 브라우저가 영상 프레임 콜백을 멈춰 1.5초 뒤 마우스 모드로 떨어질 수 있다 → 숨김을 `opacity:0; width:1px; height:1px`로.
- 숨은 탭에서 돌아온 직후 마지막 프레임 시각이 묵어 잘못 마우스 모드로 떨어질 수 있다 → 숨김→보임 첫 틱에서 `frameAt`을 현재 시각으로 맞춤.

## 리허설 목록
- 웹캠 앞 0.5~1m, 단색 배경, 역광 피하기. `D`로 FPS 20 이상.
- 주먹·두 손 펴기·브이 각 3회. 주먹 쥔 채 빠르게 휘두르기(프레임 간 손목 이동이 크면 300ms 뒤 놓임).
- 투표: 손 0·1·2개, 숫자 직접 선택, 집계 확인에서 고치기, `N` 방식 전환, 카메라 끄고 마우스 모드 투표.
- 소리: 첫 클릭 뒤 해설이 나오는지(Chrome·Safari), "25개 구"·"성수동1가" 등 Polly 발음, 첫 안내 음성 뒤 카메라 창이 열리는지.
- 화면: 프로젝터 비율(16:9·16:10·4:3)에서 펼치기 1위·25위와 라벨, 자막과 미리보기 겹침, 라벨 크기(720p에서 약 13px 추정).
- 관객 폰: `#/3d`가 펼치기·들어올림·투표 결과를 따라가는지, 무대를 떠나면 폰이 지도로 돌아오는지, `#/ar` 배너.
- Windows 한국어 IME 켠 상태에서 V·G·M·N·P 키.
- 손 인식 라이브러리는 `@mediapipe/tasks-vision` 0.10.35 고정(1.x는 실행 중 Google로 사용 통계 전송). 0.10.35의 GPU·nosimd 동작 확인.

## 보류한 다듬기 (동작 영향 작음)
- 씬 보간: 놓을 때 높이가 0.0245로 잠깐 내려감(720p 약 2px), lift(A)→lift(B) 그림자 순간이동, 펼치기 진입 중 재정렬 시 라벨 튐.
- 해설 검증기: 최상급 주어 어순 구멍, "최고 수준"·"1등" 같은 미열거 표현, 다른 달 write 시 옛 달 항목 잔존(회귀 테스트가 잡음).
- 무대 채널 코드는 본체 realtime을 복제한 것(본체 파일 수정 불가였음) — 본체가 채널 인자를 받게 되면 얇은 래퍼로.
- 토스트 문구(연속 인식 실패도 "카메라 영상이 끊겨"), 결과 보호 중 커서 모양, `SPREAD_METRIC` 두 곳 정의.
