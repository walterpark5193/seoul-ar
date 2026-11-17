# 손짓으로 들어올리는 서울 (#/stage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** seoul-ar에 `#/stage` 무대 화면을 더해, 발표자가 웹캠 앞 손짓(주먹·두 손 펴기·브이)과 손 들기 투표(카메라 또는 직접 선택)로 3D 서울을 움직이고, 미리 생성한 Bedrock 문장 + Polly 음성이 해설하며, 상태와 집계 숫자만 AppSync Events로 관객 폰에 전달한다.

**Architecture:** 손 인식(MediaPipe GestureRecognizer, wasm·모델 같은 출처)은 `recognizer.ts` 하나에 가두고 결과를 순수 데이터 `HandFrame`으로 바꿔, 제스처 판정·커서·투표 집계·무대 상태·효과 계산을 모두 순수 모듈로 만든다. `stageView`가 이들을 조립해 본체 `SeoulScene`(확장 메서드), 해설 재생기, 두 채널(`/seoul/state` 본체, `/seoul/stage` 신규)에 연결한다. 해설은 `tools/narration`이 빌드 전에 만든 정적 MP3다.

**Tech Stack:** Vite 8, TypeScript 5.9, three 0.187, `@mediapipe/tasks-vision` 1.2.3, aws-amplify 6 events, vitest 5, Node 24 도구 + `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-polly`.

**Spec:** `docs/superpowers/specs/2026-11-17-seoul-ar-stage-design.md`. 모듈 계약: `docs/CONTRACTS-stage.md`(모든 이름·타입·시그니처의 기준, 각 Task의 Interfaces는 절 번호를 가리킨다). 본체 계약 `docs/CONTRACTS.md`.

## Global Constraints

- 작업 위치 `~/claude-lab/seoul-ar-stage`(브랜치 `feat/stage`). `~/claude-lab/seoul-ar`는 읽기만(다른 세션 작업 중).
- Bash 명령문에 `http://`, `https://`, `wss://` 금지(세션 가드). 파일 내용에는 허용.
- 외부 CDN·외부 폰트 금지. wasm은 `/mediapipe/wasm/`, 모델은 `/models/gesture_recognizer.task`, 해설은 `/narration/`에서만 로드. 런타임 외부 호출은 AWS 엔드포인트만.
- 네트워크로 나가는 것은 `StateMessage`, `StageMessage`, `VoteMessage`뿐. 손 좌표·영상·골격 금지(`assertPublishable`).
- 데이터 규칙 계승: 만원·㎡, 법정동까지, 본번·부번·건물명 금지. 해설 자막의 숫자는 사실표에 있는 것만.
- 화면 한국어, 글꼴 `"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif`, 대비 4.5:1, `prefers-reduced-motion`이면 보간 없이 즉시, ALL CAPS·카드 남발·같은 그림자 반복·섹션 페이드인 금지.
- 제스처 값: minScore 0.6, confirmFrames 6, cooldownMs 800, releaseAfterMs 300. 투표: promptMs 1500, countMs 5000, manualAdvanceMs 1000, reviewMs 3000, resultMs 6000, stableMs 500, 상한 6.
- 리전 us-east-1, Bedrock `global.anthropic.claude-sonnet-5-5`(Converse, 첫 블록 reasoningContent 건너뜀), Polly `Seoyeon` generative(실패 시 neural).
- 작업자는 커밋하지 않는다(컨트롤러가 Task별 커밋). 의존성 추가 금지(Task 0에서 설치). 다른 Task 소유 파일 수정 금지. 브라우저가 필요한 확인은 "미확인"으로 보고, 거짓 확인 금지.
- 타입 확인은 `cd frontend && npx tsc --noEmit` 출력 중 자기 파일 오류 0(병렬 작업 중 남의 미완성 파일 오류는 무시).

## Review Focus

1. 손 개수가 프레임마다 1↔2로 튈 때: 투표 표는 500ms 이상 유지된 값만, 순간 최댓값이 표가 되면 안 된다. 테스트: Task 4 `flicker never yields transient max`.
2. 주먹을 쥔 채 손이 화면 밖으로 나갈 때: 300ms 뒤 release, 구가 계속 떠 있으면 안 된다. 테스트: Task 3 `release on hand loss`, Task 6 `release settles focus`.
3. 해설 manifest가 없거나 MP3가 404일 때: 자막만 보이고 무대는 계속 동작. 테스트: Task 10 `missing file shows caption then continues`, Task 18 `stage mounts with null manifest`.
4. 발행이 거부될 때(본체 Task 8 잠금 이후 등): 상단에 빨간 "발행 실패", 조작은 계속. 테스트: Task 18 `publish failure flags top bar`.
5. 거래 0건 구(medPerM2 null): 펼치기에서 뒤쪽·최소 높이, 후보 선정 제외, 해설은 NaN 없이 "거래가 없었습니다" 취지. 테스트: Task 14 `null values last`, Task 6 `defaultCandidates skips null`, Task 11 `facts for empty gu`, Task 12 `fallback for n 0`.

---

### Task 0: 준비 (컨트롤러)

**Files:**
- Create: `frontend/src/stage/types.ts` (CONTRACTS-stage 1절 그대로)
- Modify: `frontend/package.json`, `frontend/package-lock.json`, `tools/package.json`, `tools/package-lock.json`, `.gitignore`

- [ ] **Step 1:** `cd frontend && npm ci && npm install @mediapipe/tasks-vision@1.2.3`, `cd tools && npm ci && npm install @aws-sdk/client-bedrock-runtime @aws-sdk/client-polly`, `cd infra && npm ci`.
- [ ] **Step 2:** `frontend/src/stage/types.ts` 작성, `.gitignore`에 `frontend/public/models/`, `frontend/public/mediapipe/` 추가.
- [ ] **Step 3:** 기준선 `cd frontend && npx vitest run && npx tsc --noEmit`, `cd tools && npx vitest run` 통과 확인.
- [ ] **Step 4:** 모델 파일이 본체 `frontend/public/models/`에 있으면 워크트리로 복사.
- [ ] **Step 5:** 커밋 `chore(stage): deps, shared stage types, contracts, plan`.

### Task 1: 정적 자산 파이프라인

**Files:**
- Create: `frontend/scripts/assets.mjs`, `frontend/scripts/copy-mediapipe.mjs`, `frontend/scripts/check-assets.mjs`, `frontend/scripts/assets.test.mjs`
- Modify: `frontend/package.json`(scripts만: `predev`, `prebuild` = `node scripts/copy-mediapipe.mjs && node scripts/check-assets.mjs`), `frontend/vite.config.ts`(test include에 `scripts/**/*.test.mjs` 추가), `README.md`(모델 받는 법 절)

**Interfaces:**
- Produces: `export function isZipMagic(bytes: Uint8Array): boolean`(첫 두 바이트 `P`,`K`), `export async function checkModel(path): Promise<{ ok: boolean; reason: "missing" | "not-zip" | null; bytes: number }>`, `export async function copyWasm(srcDir, dstDir): Promise<string[]>`(복사한 파일 이름).

- [ ] **Step 1: 실패하는 테스트** `assets.test.mjs`: `isZipMagic` PK/빈 배열/HTML; `checkModel` 없는 경로 → missing, 임시 PK 파일 → ok, 임시 텍스트 → not-zip; `copyWasm` 임시 디렉터리 두 파일 복사.
- [ ] **Step 2:** `cd frontend && npx vitest run scripts` 실패 확인.
- [ ] **Step 3: 구현.** `check-assets.mjs`는 모델이 없거나 zip이 아니면 경고만 출력하고 exit 0(무대는 마우스 모드로 동작). README에는 설계 3절의 경로와 명령(주소는 README 파일 안에만).
- [ ] **Step 4:** 테스트 통과, `node scripts/copy-mediapipe.mjs`가 `public/mediapipe/wasm/`에 `vision_wasm_internal.wasm` 등 4개 생성 확인.

### Task 2: 커서 (One Euro, 손바닥 중심, 화면 매핑)

**Files:** Create `frontend/src/stage/hands/cursor.ts`, `frontend/src/stage/hands/cursor.test.ts`

**Interfaces:** Produces CONTRACTS-stage 2.1 전부. Consumes 1절 `Vec3`, `Point`.

- [ ] **Step 1: 테스트**: `palmCenter` 다섯 점 평균; `mapToScreen({x:0.2,y:0.5})` 거울·margin 0.1 → x 0.75, y 0.5; 가장자리 `{x:0.05}` → 1로 자름; `mirror:false`; `createOneEuro` 상수 입력 → 같은 값, 고주파 지터(±0.01 교대, 60Hz) 출력 진폭이 입력의 50% 미만, 큰 계단 이동은 200ms 안에 90% 따라감; `toNdc({x:0,y:0})` → (-1, 1); `createCursorMapper` reset 뒤 첫 값은 필터 지연 없음.
- [ ] **Step 2:** `npx vitest run stage/hands/cursor` 실패 확인.
- [ ] **Step 3: 구현** (표준 One Euro: alpha = 1/(1 + τ/Te), τ = 1/(2π·cutoff), cutoff = minCutoff + beta·|dx̂|).
- [ ] **Step 4:** 통과 확인.

### Task 3: 제스처 판정기

**Files:** Create `frontend/src/stage/hands/gestureMachine.ts`, `frontend/src/stage/hands/gestureMachine.test.ts`

**Interfaces:** Produces CONTRACTS-stage 2.2. Consumes 1절 `HandFrame`, `GestureOutput`, `VOTE_MAX`.

- [ ] **Step 1: 테스트**(합성 프레임 헬퍼 `hand(gesture, score, wrist=[x,y], palmWidth)`로 33ms 간격 시퀀스):
  - `grab after 6 frames`: 주먹 5프레임 → 이벤트 없음, 6번째 → `grab`.
  - `release after open`: grab 뒤 편 손 6프레임 → `release`.
  - `release on hand loss`: grab 뒤 손 없음 10프레임(330ms) → `release` 한 번.
  - `one open palm is cursor only`: 한 손 Open_Palm 30프레임 → 이벤트 없음.
  - `spread needs two open palms`: 두 손 Open_Palm 6프레임 → `spread` 한 번, 계속 유지해도 추가 없음, 한 프레임 깨진 뒤 쿨다운 지나 다시 6프레임 → 두 번째 `spread`.
  - `spread ignored while fist`: 한 손 주먹(grab 후) + 다른 손 편 상태 → spread 없음.
  - `cooldown`: grab→release 직후 800ms 안 주먹 → grab 없음, 이후 → grab.
  - `low score ignored`: 주먹 score 0.5 → 없음.
  - `victory latch`: Victory 20프레임 → 한 번.
  - `voting silences`: ctx.voting true면 어떤 이벤트도 없음, grab 상태였으면 fist false로(이벤트 없음).
  - `primary follows nearest wrist`: 두 손 중 직전 주 손 쪽 손목 근처 손이 primary 유지.
  - `handCount capped 6`.
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현. **Step 4:** 통과 확인.

### Task 4: 투표 손 세기

**Files:** Create `frontend/src/stage/hands/voteCounter.ts`, `frontend/src/stage/hands/voteCounter.test.ts`

**Interfaces:** Produces CONTRACTS-stage 2.3.

- [ ] **Step 1: 테스트**: `stable 2 for 600ms → 2`; `flicker never yields transient max`(1,2,1,2… 33ms 교대 5초 + 중간에 1이 600ms 유지 → 1); `no stable segment → null`(매 100ms 바뀜); `zero hands stable → 0`; `max over segments`(1 600ms, 2 600ms, 1 600ms → 2); `cap 6`(8손 600ms → 6); `reset clears`; `exactly 500ms counts`(t 0과 t 500에 같은 값 → 인정).
- [ ] **Step 2–4:** 실패 확인, 구현, 통과 확인.

### Task 5: 인식기 어댑터 (MediaPipe·카메라)

**Files:** Create `frontend/src/stage/hands/recognizer.ts`, `frontend/src/stage/hands/recognizer.test.ts`

**Interfaces:** Produces CONTRACTS-stage 2.4. 프론트에서 `@mediapipe/tasks-vision`을 import하는 유일한 파일(동적 import).

- [ ] **Step 1: 테스트**: `toHandFrame` 두 손(제스처·랜드마크·handedness) 변환, `handednesses`만 있는 구버전 결과, 모르는 제스처 이름 → "None", 제스처 배열이 비면 "None" score 0; `startHandSource` 주입: getUserMedia가 NotAllowedError → `{ok:false, reason:"denied"}`, NotFoundError → "no-camera", modelExists false → "model-missing", GPU 생성 실패·CPU 성공 → ok·delegate "CPU", 둘 다 실패 → "wasm-failed". (video 요소는 가짜 객체 주입, `document.createElement`가 없으면 deps.createVideo로 대체 — 시그니처에 `createVideo?: () => HTMLVideoElement` 추가 허용.)
- [ ] **Step 2–4:** 실패 확인, 구현(프레임 루프 fps는 최근 30프레임 이동 평균), 통과 확인. 실제 카메라·GPU 동작은 "미확인".

### Task 6: 무대 상태 리듀서

**Files:** Create `frontend/src/stage/stageState.ts`, `frontend/src/stage/stageState.test.ts`

**Interfaces:** Produces CONTRACTS-stage 3.1. Consumes 1절 타입, 본체 `Stat`, `Metric`, `GU_ORDER`.

- [ ] **Step 1: 테스트**:
  - 조작: `grab lifts hover`, `grab without hover ignored`, `release settles focus`(focus=lifted, mode map), `spread toggles`, `spread ignored while lifted`, `victory clears`.
  - 투표 흐름(camera): voteStart(now 0) → prompt endsAt 1500 → tick 1500 → counting endsAt 6500 → tick 6500 cameraCount 2 → counts[0]=2 source camera, index 1 prompt → … → 3번째 뒤 review endsAt +3000 → tick → result, winner, focus=winner, endsAt +6000 → tick → vote null.
  - `camera null awaits manual`: counting 끝 cameraCount null → awaitManual endsAt null → voteSet(index 0, n 1, now) → endsAt now+1000 → tick → 다음 후보.
  - `manual method has no timer`: input mouse에서 voteStart → method manual, counting endsAt null, tick 1만 ms 지나도 그대로, voteSet → 1초 뒤 다음.
  - `manual beats camera`: counting 중 voteSet(0, 3) → 창 끝 cameraCount 1이어도 counts[0]=3 source manual.
  - `review edit pauses auto confirm`: review에서 voteSet(2, 0) → reviewEdited true, endsAt null, tick 무한히 지나도 review, voteConfirm → result.
  - `voteSet rejects out of range`: n 7, -1, 1.5 무시. 아직 안 온 후보(review 전) 무시.
  - `tie goes to first`, `all zero winner first and allZero`.
  - `gestures ignored during vote`, `result phase gesture clears vote`.
  - `setInput mouse switches method`, `voteMethod camera restarts window`.
  - `defaultCandidates picks 1st 13th 25th`, `defaultCandidates skips null`(null 2개 → 23개 중 첫째·가운데(11번째)·마지막), `parseVoteParam` 유효 이름만·중복 제거·없으면 null.
- [ ] **Step 2–4:** 실패 확인, 구현, 통과 확인.

### Task 7: 효과 계산

**Files:** Create `frontend/src/stage/effects.ts`, `frontend/src/stage/effects.test.ts`

**Interfaces:** Produces CONTRACTS-stage 3.2 `diffEffects`, `NARRATION_IDS`. Consumes 1절 `StageState`, `Effect`(상태 객체는 테스트에서 직접 만든다. Task 6 함수에 의존하지 않음).

- [ ] **Step 1: 테스트**: `lift emits scene.lift publish.stage narrate gu`(id `gu-202611-강남구`, interrupt true); `release emits lift null focus publish.state`(map-back 없음); `spread emits layout spread-intro publish.stage`; `victory from spread emits map-back`; `hover only scene.hover`; `month change emits scene.data publish.state`; `vote round start narrates vote-intro protect`; `prompt entry narrates vote-prompt-{gu} protect not interrupt`; `counting entry resets counter`; `result emits vote-result-{gu}-{n} then gu clip then publish.vote`(순서 확인); `all zero emits vote-none`; `no publish.vote before result`; `order is fixed`(여러 변화가 한 번에 올 때 계약 순서); `NARRATION_IDS literals`(`vote-result-마포구-2`, `vote-none-노원구`, `stage-hello`).
- [ ] **Step 2–4:** 실패 확인, 구현, 통과 확인.

### Task 8: 키·포인터 입력

**Files:** Create `frontend/src/stage/keys.ts`, `frontend/src/stage/keys.test.ts`

**Interfaces:** Produces CONTRACTS-stage 3.3.

- [ ] **Step 1: 테스트**: 계약 3.3 키 표 전부(대소문자 포함), `digits only during vote`, `digit targets review row in review`, `enter only in review`, `n toggles method only during vote`, `unknown key null`; `attachPointer`는 가짜 요소(addEventListener 기록, getBoundingClientRect {left:100,top:50,width:200,height:100})로 clientX 200, clientY 100 → move({x:0.5,y:0.5}), 해제 함수가 리스너 제거.
- [ ] **Step 2–4:** 실패 확인, 구현, 통과 확인.

### Task 9: 무대 채널과 메시지 검사

**Files:** Create `frontend/src/stage/net/messages.ts`, `frontend/src/stage/net/messages.test.ts`, `frontend/src/stage/net/stageChannel.ts`, `frontend/src/stage/net/stageChannel.test.ts`

**Interfaces:** Produces CONTRACTS-stage 4.1, 4.2. Consumes 본체 `EventsConfig`, `ConnStatus`, `BroadcastLike`(`realtime/mock.ts`에서 type import만), `GU_ORDER`.

- [ ] **Step 1: 테스트**: `isStageMessage` 정상/모르는 구/ts NaN/v 2 거절; `isVoteMessage` 길이 3 아님·counts 7·1.5 거절, null 허용; `assertPublishable` 추가 키(`landmarks`, `frame`, `x`) → throw, 정상 통과; `toStageMessage`/`toVoteMessage` 키가 ALLOWED_KEYS와 정확히 같음; mock 채널: subscribe 후 publish 전달, 손상 메시지 무시, 탭 간(가짜 BroadcastLike) 전달, 잘못된 메시지 publish → reject; `makeStageChannel(null)` → mock.
- [ ] **Step 2–4:** 실패 확인, 구현(AppSync 쪽은 본체 `appsync.ts` 구조를 따라 별도 파일로; 단위 테스트는 mock만, AppSync 실연결은 "미확인"), 통과 확인.

### Task 10: 해설 재생기

**Files:** Create `frontend/src/stage/narrator.ts`, `frontend/src/stage/narrator.test.ts`

**Interfaces:** Produces CONTRACTS-stage 5.1.

- [ ] **Step 1: 테스트**(가짜 AudioLike·가짜 타이머): `plays file from base`(src `/narration/a.mp3`), `caption on start and cleared 1500ms after end`, `interrupt stops current`, `protected not interrupted`(protect 재생 중 interrupt → 끝난 뒤 바로), `queue order`, `missing file shows caption then continues`(onerror → caption 2500ms → 다음), `unknown id skipped`, `muted still captions`, `null manifest is silent`, `loadManifest` 404·형식 오류 → null.
- [ ] **Step 2–4:** 실패 확인, 구현, 통과 확인.

### Task 11: 해설 id·사실표·템플릿

**Files:** Create `tools/narration/ids.mjs`, `tools/narration/facts.mjs`, `tools/narration/templates.mjs`, `tools/narration/facts.test.mjs`, `tools/narration/templates.test.mjs`

**Interfaces:** Produces CONTRACTS-stage 5.2, 5.3의 `NARRATION_IDS`, `NATIVE_COUNT`, `buildFacts`, `templateLines`. Consumes 본체 데이터 스키마(CONTRACTS 2절), `tools/data/gu.mjs`의 `GU_ORDER`.

- [ ] **Step 1: 테스트**: `buildFacts` 실데이터 `frontend/public/data`로 25개·GU_ORDER 순·rankPrice 1~k 중복 없음; `facts for empty gu`(n 0 → medPerM2 null, rankPrice null, topDong null, NaN 없음); `topDong prefers n>=3`; `templateLines count 204`, id 중복 없음, `vote-result-강남구-2` caption "2표로 강남구가 뽑혔습니다." speech "두 표로 강남구가 뽑혔습니다.", `spread-intro` speech에 "제곱미터", 모든 문장에 `undefined`·`NaN` 없음; `ids match frontend literals`(문자열 고정값 비교).
- [ ] **Step 2–4:** 실패 확인, 구현, 통과 확인.

### Task 12: 해설 문장 쓰기 (Bedrock)

**Files:** Create `tools/narration/write.mjs`, `tools/narration/write.test.mjs`

**Interfaces:** Produces CONTRACTS-stage 5.3 write 부분. Consumes Task 11 `buildFacts`, `NARRATION_IDS`(CLI에서만 import; 테스트는 사실표 객체를 직접 만든다).

- [ ] **Step 1: 테스트**(가짜 client `send`): `extractText skips reasoningContent`; `parseScript` 코드펜스·앞뒤 잡문 허용, 필드 누락 거절; `allowedNumbers` 52.6억·2,890·25·1위; `validateScript` 사실표 밖 숫자("3,100만 원") 거절, 91자 거절, "아파트명"·"번지" 같은 금지어 거절, 정상 통과; `writeScripts retries then falls back`(두 번 검증 실패 → 템플릿, failures에 id); `fallback for n 0`("거래가 없었습니다" 포함, 숫자 없음); `buildPrompt` 사실표 숫자 포함·JSON 지시 포함.
- [ ] **Step 2–4:** 실패 확인, 구현(CLI는 `--data`, `--month`, `--out`, 동시 호출 4개 제한), 통과 확인. 실제 Bedrock 호출은 Task 20에서.

### Task 13: 음성 합성 (Polly)과 manifest

**Files:** Create `tools/narration/synth.mjs`, `tools/narration/synth.test.mjs`

**Interfaces:** Produces CONTRACTS-stage 5.3 synth 부분과 5.1 manifest 형식. Consumes Task 11 `templateLines`(CLI), Task 12 `scripts.json` 형식(`items[id] = {caption, speech, source}`).

- [ ] **Step 1: 테스트**(가짜 client, 임시 outDir): `synthesizes and writes mp3`(파일 바이트 = 가짜 스트림), `generative failure falls back to neural`(manifest engine 기록은 항목별 `engine` 없이 상위 engine, 대체 사용 id는 결과 `fallbacks`에), `skips unchanged hash`(previous manifest hash 같고 파일 있음 → send 호출 0), `resynth when text changed`, `buildManifest shape`(v 1, items[id].file `${id}.mp3`, caption, hash), `speechHash stable 16 hex`.
- [ ] **Step 2–4:** 실패 확인, 구현(동시 4개, 실패 2회 재시도), 통과 확인.

### Task 14: 씬 확장 (펼치기·들어올림·hover·pick)

**Files:** Create `frontend/src/scene/spreadLayout.ts`, `frontend/src/scene/spreadLayout.test.ts`. Modify `frontend/src/scene/seoulScene.ts`, `frontend/src/scene/seoulScene.test.ts`(테스트 추가만)

**Interfaces:** Produces CONTRACTS-stage 6.1, 6.2. 기존 `SeoulScene` 메서드와 상수는 그대로.

- [ ] **Step 1: 테스트**: `spreadLayout` 25개, 1위가 x 최소(왼쪽), x 범위 ±0.9·sin50°, z 0~0.9(1-cos50°), height 0.02~0.30, `null values last`(null 구는 rank null·MIN 높이·뒤쪽, gus 순서), count 지표 정렬; 씬: `lift raises to LIFT_Y`(lift(gu) 뒤 update(1, cam) → 해당 메시 그룹 y≈0.12, 나머지 dim 색), `lift null restores`, `setLayout spread moves centroid to slot`(update(1) 뒤 강남구 그룹 위치가 slot x,z와 1e-3 안), `setLayout map restores`, `reducedMotion instant`, `pick returns gu under ndc`(카메라를 강남구 centroid 위에서 내려다보게 두고 ndc(0,0) → "강남구"), `pick ignores outlines and labels`, `setHover idempotent`.
- [ ] **Step 2–4:** 실패 확인, 구현, 통과 확인(기존 seoulScene 테스트 전부 통과 유지).

### Task 15: 무대 렌더러와 카메라

**Files:** Create `frontend/src/stage/stageRenderer.ts`, `frontend/src/stage/stageRenderer.test.ts`

**Interfaces:** Produces CONTRACTS-stage 7. Consumes 6.2 `LAYOUT_SECONDS`(값 0.8을 상수 import), 본체 `easeOutCubic`.

- [ ] **Step 1: 테스트**: `MAP_POSE looks down about 55°`(atan2(dy, dz) 50~60°), `SPREAD_POSE about 15–25°`, `lerpPose endpoints and midpoint`, `createStageRenderer returns null without WebGL`(renderer 팩토리 주입 허용: `opts.makeRenderer?`).
- [ ] **Step 2–4:** 실패 확인, 구현(본체 orbitView의 렌더러 설정·조명 톤 재사용, 픽셀 비 최대 2, ResizeObserver), 통과 확인.

### Task 16: 투표 패널·상단·안내·시작 화면

**Files:** Create `frontend/src/stage/ui/votePanel.ts`, `frontend/src/stage/ui/votePanel.test.ts`, `frontend/src/stage/ui/vote.css`, `frontend/src/stage/ui/hud.ts`, `frontend/src/stage/ui/hud.test.ts`, `frontend/src/stage/ui/hud.css`

**Interfaces:** Produces CONTRACTS-stage 8절 votePanel·hud 함수. Consumes 본체 `ui/html.ts` 이스케이프, 1절 타입.

- [ ] **Step 1: 테스트**: 각 phase 문구(계약 8절 문자열 그대로), `buttons 0..6 per row`·선택값 aria-pressed, `future rows disabled before review`, `review all rows enabled`, `source labels 카메라/직접`, `awaitManual message`, `confirm button only in review`, `method toggle pressed state`; hud: 연결 상태 네 가지 문구, `publish failure flags top bar` 문구 "발행 실패", 손/마우스 안내 줄 문자열, 시작 화면 두 버튼과 모델 없음 안내("동작 인식 모델이 없어 마우스로 진행합니다" 취지), 자막 null이면 빈 영역.
- [ ] **Step 2–4:** 실패 확인, 구현(CSS는 본체 토큰 변수 사용, 자막 40px/600), 통과 확인.

### Task 17: 미리보기·골격·커서·진단

**Files:** Create `frontend/src/stage/ui/overlay.ts`, `frontend/src/stage/ui/overlay.test.ts`, `frontend/src/stage/ui/overlay.css`

**Interfaces:** Produces CONTRACTS-stage 8절 overlay 함수.

- [ ] **Step 1: 테스트**: `nextPreviewMode` 순환, `HAND_CONNECTIONS` 21개·인덱스 0~20, `drawSkeleton` 가짜 ctx 호출 기록(손 2개 → 선 42개, 점 42개, mirror면 x가 w - x·w), `cursorClass` 조합, `renderDiag` 값 표시(fps 소수 0자리, cursor null "—").
- [ ] **Step 2–4:** 실패 확인, 구현(미리보기 240px 오른쪽 아래, 거울 `transform: scaleX(-1)`, 커서 56px 링), 통과 확인.

---

### Task 18: 무대 조립과 라우트 (Task 1–17 뒤)

**Files:** Create `frontend/src/views/stageView.ts`, `frontend/src/views/stageView.test.ts`, `frontend/src/stage/stage.css`. Modify `frontend/src/router.ts`, `frontend/src/router.test.ts`, `frontend/src/main.ts`, `frontend/src/views/types.ts`, `frontend/src/views/hostView.ts`

**Interfaces:** Produces CONTRACTS-stage 9절. Consumes 2~8절 전부.

- [ ] **Step 1: 테스트**(가짜 씬·가짜 렌더러·mock 채널 두 개·가짜 narrator 주입; `mountStageView`의 내부 조립을 `createStageController(deps)` 순수에 가까운 함수로 분리해 테스트): `parseRoute("#/stage") → "stage"`, `parseRoute("#/stage?vote=강남구") → "stage"`; `mouse grab release publishes state then stage`(순서·페이로드 키가 ALLOWED_KEYS/StateMessage 키만); `no landmarks in any payload`; `spread key toggles layout and narrates`; `vote with manual input completes and publishes vote result`(V → 숫자 2, 1, 0 → Enter 대기 없이 3초 → result → publish.vote 1회); `publish failure flags top bar`(채널 publish reject → 상단 HTML에 "발행 실패", 다음 성공 시 해제); `stage mounts with null manifest`; `single month arrows no-op`; `hand source failure falls back to mouse with toast`.
- [ ] **Step 2–4:** 실패 확인, 구현, `cd frontend && npx vitest run && npx tsc --noEmit` 전체 통과.

### Task 19: 관객 뷰어 따라가기 (Task 9, 14 뒤)

**Files:** Create `frontend/src/views/stageFollow.ts`, `frontend/src/views/stageFollow.test.ts`. Modify `frontend/src/views/orbitView.ts`, `frontend/src/views/arView.ts`, `frontend/src/views/arView.test.ts`(추가만), `frontend/src/app.css`(배너·투표 줄 스타일 추가만)

**Interfaces:** Produces CONTRACTS-stage 10절. Consumes 4.2 `StageChannel`, 6.2 `setLayout`/`lift`, 9절 `ViewContext.stageChannel`.

- [ ] **Step 1: 테스트**: `voteLine` 문자열 그대로; `follow true applies layout and lift`; `follow false ignores layout but shows vote`; `malformed ignored`; arView: StageMessage 수신 → 배너 렌더, 탭 → navigate("#/3d").
- [ ] **Step 2–4:** 실패 확인, 구현, 통과 확인.

### Task 20: 해설 생성 실행 (Task 11–13 뒤)

**Files:** Create `tools/narration/scripts.json`, `frontend/public/narration/*.mp3`, `frontend/public/narration/manifest.json`

- [ ] **Step 1:** `cd ~/claude-lab/seoul-ar-stage && node tools/narration/write.mjs --data frontend/public/data --month 202611 --out tools/narration/scripts.json` → 25개, failures 보고.
- [ ] **Step 2:** scripts.json 25개 caption을 읽고 사실과 다르거나 어색한 문장은 손으로 고쳐 다시 검증(`validateScript`).
- [ ] **Step 3:** `node tools/narration/synth.mjs --scripts tools/narration/scripts.json --data frontend/public/data --month 202611 --out frontend/public/narration` → 229개(204 + 25) mp3와 manifest, 총 크기 보고.
- [ ] **Step 4:** 두 번째 실행이 전부 skip인지 확인(캐시).

### Task 21: 통합 확인 (컨트롤러)

- [ ] `cd frontend && npx vitest run && npx tsc --noEmit && npm run build`, `cd tools && npx vitest run`, `cd infra && node --test`.
- [ ] 번들 확인: `dist/assets`에서 MediaPipe 코드(`GestureRecognizer` 문자열)가 무대 청크에만 있고 진입 청크에는 없음. `dist/mediapipe/wasm/*.wasm`, `dist/narration/manifest.json` 존재, `dist/models/`는 모델이 있을 때만.
- [ ] 가능하면 `npx vite preview` + 헤드리스 크로미움으로 `#/stage` 마우스 모드 스크린샷. 불가하면 "미확인".
- [ ] 브랜치 전체 리뷰(독립 리뷰어 1명), 결과 반영.
- [ ] 본체 세션에 알림(SendMessage, 사용자 확인 후): 새 채널 `/seoul/stage`를 쓰므로 Task 8 권한 부여자가 `seoul` 네임스페이스 전체 발행을 허용해야 하고, `#/stage`도 발표자 암호를 쓴다는 것. `main.ts`·`router.ts`·`views/types.ts`·`hostView.ts`·`orbitView.ts`·`arView.ts`·`seoulScene.ts` 변경 예고.
- [ ] 병합·배포는 사용자와 본체 세션 진행에 맞춰 확인(이 계획 범위 밖).
