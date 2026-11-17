# 무대 회전·확대 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `#/stage`에서 빈 곳 주먹 끌기·두 주먹으로 3D 서울을 지구본처럼 돌리고(관성, 잡아서 멈춤) 두 주먹 벌리기·휠로 확대하며, 큰 화면이 따라오고, 가이드에 무대 사용법을 싣는다.

**Architecture:** 연속 값(yaw·zoom·관성)은 순수 회전기 `rotate.ts`가 들고, 리듀서는 잡기 상태(rotate·spinning)만 관리하며 효과(rotate.*)로 회전기를 조작한다. 회전은 도시 group의 rotation.y, 확대는 렌더러 카메라 거리. 큰 화면은 StageMessage의 yaw·zoom을 따른다.

**Tech Stack:** 기존 그대로(Vite 8, TS 5.9, three 0.187, vitest 5, @mediapipe/tasks-vision 0.10.35).

**Spec:** `docs/superpowers/specs/2026-11-17-stage-rotate-design.md`. 계약: `docs/CONTRACTS-stage.md` 13절(이 기능의 모든 이름·시그니처), 기존 절은 그대로.

## Global Constraints
- 작업 위치 `~/claude-lab/seoul-ar-stage`(브랜치 feat/stage). `~/claude-lab/seoul-ar`(main, 배포 폴더)는 건드리지 않는다.
- Bash 명령문에 URL 스킴 금지(세션 가드). 파일은 Write/Edit.
- 네트워크로 나가는 새 값은 StageMessage의 yaw·zoom 두 숫자뿐. 손 좌표 금지(assertPublishable).
- 값: degPerScreen 180, friction 2.5/s, maxSpeedDeg 720, flickMinDegPerSec 60, velocityWindowMs 100, zoom 0.7~1.6, wheelStep 0.1, resetSeconds 0.6, 큰 화면 발행 최대 5Hz.
- 회전·확대는 지도 모드에서만. spread 진입·victory·voteStart·입력 전환 때 정면·1배 복귀. lifted·투표 중 회전 없음. 회전 중 hover 없음. 관성 중 주먹은 잡기 전용(들지 않음).
- 화면 문자열 한국어, ALL CAPS 금지, reduced-motion이면 리셋 보간 즉시.
- 공유 타입은 `frontend/src/stage/types.ts`(컨트롤러가 13.1대로 이미 반영). 타입 확장 때문에 생긴 tsc 오류는 각 작업이 자기 파일에서 고친다.
- 커밋: `bash .superpowers/sdd/2026-11-17-stage-rotate/commit-task.sh "<msg>" <files>`만. 서브에이전트 금지.

## Review Focus
1. 커서를 빠르게 움직이다 주먹이 잠깐 잡혀도 회전이 튀면 안 된다(주먹 확정 6프레임 유지, 회전은 grab 이후 Δx만). 테스트: R3 `grab without hover starts rotate only in map`, R1 `move before grab ignored`.
2. 관성 중 구 위에서 주먹 → 멈추기만, 들지 않음. 테스트: R3 `grab while spinning catches, no lift`.
3. 펼치기·투표가 돌아간 채 보이면 안 됨. 테스트: R3 `spread/victory/voteStart emit rotate.reset`, R8 `spread resets yaw to 0`.
4. 두 주먹 중 한 손이 잠깐 빠지면 회전이 끊기지 않아야 함(releaseAfterMs). 테스트: R2 `twoFist survives 1-frame dropout`.
5. 큰 화면 메시지에 yaw·zoom 외 값이 없어야 함. 테스트: R5 `stage message keys with view`.

---

### Task R1: 회전기 (`frontend/src/stage/rotate.ts`, `rotate.test.ts`)
**Interfaces:** Produces 계약 13.2. Consumes 1절 `Point`.
- [ ] 테스트: `drag right increases yaw`(x 0.4→0.6 → yaw ≈ +36°), `move before grab ignored`, `slow release no spin`, `flick spins and decays`(속도 > 60°/s로 놓기 → spinning, tick 누적 후 idle, 감속 단조), `max speed clamp`, `catch stops spin keeping yaw`, `grabOne while spinning catches`, `two-hand midpoint rotates and distance zooms`(거리 2배 → zoom 2배→1.6 클램프), `wheel zoom in/out clamp`, `reset shortest path and instant`, `yaw normalized to (-π, π]`, `reset while spinning stops spin`.
- [ ] 실패 확인 → 구현 → 통과.

### Task R2: 두 주먹 (`frontend/src/stage/hands/gestureMachine.ts`, `.test.ts`)
**Interfaces:** Produces 계약 13.3, GestureOutput.secondary. 기존 테스트 전부 유지.
- [ ] 테스트: `secondary is the other hand`, `twoFist after 6 frames both fists`, `twoFist latch`, `twoFistEnd when one opens`, `twoFist survives 1-frame dropout`, `twoFistEnd after hand loss 300ms`, `voting silences twoFist`, `single fist grab/release unaffected by second fist`.
- [ ] 실패 확인 → 구현 → 통과.

### Task R3: 무대 상태 (`stageState.ts`, `effects.ts` + tests)
**Interfaces:** Produces 계약 13.4. initialStageState에 rotate "none", spinning false.
- [ ] 테스트: `grab without hover starts rotate only in map`, `grab in spread without hover ignored`, `grab with hover still lifts`, `grab while spinning catches, no lift`(효과 rotate.catch, rotate.grabOne 순), `release ends rotate with rotate.release`, `twoFist starts two-hand rotate in map`, `twoFist ignored while lifted or voting or spread`, `twoFistEnd releases`, `spinState sets spinning`, `spread/victory/voteStart emit rotate.reset`(순서: rotate.reset이 scene.layout 앞), `hover ignored while rotating`, `setInput resets rotate`, 기존 테스트 유지(픽스처에 새 필드).
- [ ] 실패 확인 → 구현 → 통과.

### Task R4: 렌더러 확대·휠 입력 (`stageRenderer.ts`, `keys.ts` + tests)
**Interfaces:** Produces 계약 13.5.
- [ ] 테스트: `setZoom 2 halves distance to target`, `zoom clamped`, `zoom kept across setMode tween and resize`, `attachPointer wheel calls handler with deltaY and prevents default`, `wheel listener removed on detach`.
- [ ] 실패 확인 → 구현 → 통과.

### Task R5: 채널 yaw·zoom과 큰 화면 (`stage/net/messages.ts`, `views/stageFollow.ts`, `views/orbitView.ts` + tests)
**Interfaces:** Produces 계약 13.6.
- [ ] 테스트: `stage message keys with view`(yaw·zoom 포함 시 키 = ALLOWED_KEYS.stage), `isStageMessage rejects bad yaw/zoom`(NaN, 4, zoom 2), `toStageMessage without view omits fields`, `onView called while following`, `onView reset on stale`, `follow off → onView(0,1)`; orbitView 테스트(기존 orbitView.test.ts 확장): 큰 화면은 yaw 적용, 일반 3D는 무시.
- [ ] 실패 확인 → 구현 → 통과.

### Task R6: 안내 줄 (`stage/ui/hud.ts`, `hud.test.ts`)
**Interfaces:** 계약 13.7 문자열 그대로.
- [ ] 테스트 갱신 → 구현 → 통과.

### Task R7: 가이드·README·후속 메모 (`docs/GUIDE.md`, `README.md`, `docs/superpowers/2026-11-17-seoul-ar-stage-followups.md`)
- [ ] GUIDE에 "무대 화면(#/stage)" 절 추가(기존 절 번호 체계에 맞춤): 여는 법(호스트 "무대 열기"), 무대 시작/마우스로 시작, 손짓 표(커서·주먹 들기·빈 곳 주먹 돌리기·관성과 잡아 멈추기·두 주먹 돌리기/확대·두 손 펴기·브이), 마우스·키(클릭·드래그·휠·스페이스·Esc·V·N·숫자 0~6·Enter·G·M·C·D·H·P·←→), 투표 진행(카메라/직접 선택, 집계 확인), 큰 화면이 따라오는 것과 폰은 안 따라오는 것, 리허설 팁, 문제 해결(마우스 모드로 바뀌는 이유들, 소리 막힘), 개인정보(영상은 브라우저 밖으로 안 나감, 숫자만, 모델 파일 1회 다운로드, 실행 중 외부 호출 없음). 기존 1절 진행 순서와 4절 문제 해결에 무대 항목 한 줄씩 연결.
- [ ] README 무대 절에 회전 손짓 한 줄, 후속 메모 리허설 목록에 회전 항목.
- [ ] 문서 사실 확인: 키·문구는 계약(9절·11절·13절)과 hud.ts·keys.ts 현재 코드에서 확인.

---

### Task R8: 조립 (`frontend/src/views/stageView.ts`, `stageView.test.ts`) — R1–R6 뒤
**Interfaces:** Consumes 13.2–13.6.
- [ ] 효과 실행: rotate.grabOne(커서 점), grabTwo(두 손바닥 점: primary·secondary의 손바닥 중심을 mapToScreen), release, catch, reset(reducedMotion이면 instant). 프레임마다 rotate one/two면 move/moveTwo, 매 렌더 tick → city.group.rotation.y = yaw, renderer.setZoom(zoom). 회전기 모드가 spinning으로 바뀌거나 끝나면 spinState 이벤트.
- [ ] 마우스: 빈 곳 누르기(grab 경로) → 회전, pointer move → move, up → release, wheel → (지도 모드·lifted 없음·투표 아님일 때만) rotator.wheel. 관성 중 클릭 = 잡기.
- [ ] 회전 중 hover 계산 생략(hover null).
- [ ] 큰 화면 발행: yaw·zoom 변화 중 ≤5Hz StageMessage(view 포함), 멈추면 1회, 하트비트 포함.
- [ ] 테스트: `fist on empty drags rotation`, `flick then fist catches`, `two fists rotate and zoom`, `mouse drag rotates and wheel zooms`, `spread resets yaw to 0`, `rotation publishes at most 5Hz with yaw zoom`, `no hover while rotating`, `lifted blocks rotation`.
- [ ] 전체 `npx vitest run && npx tsc --noEmit && npm run build`.

### Task R9: 통합 확인·병합 (컨트롤러)
- [ ] 전체 테스트·tsc·빌드·check-bundle, 브랜치 리뷰 1회, main 상태 확인 후 fast-forward와 푸시(사용자 승인 범위: "구현하고 가이드 업데이트").
