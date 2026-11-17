# 무대(#/stage) 모듈 계약서

`#/stage` 작업자 전원이 읽는 단일 기준. 본체 계약 `docs/CONTRACTS.md`를 계승한다. 이름·경로·스키마·시그니처를 그대로 쓴다. 바꿔야 하면 바꾸지 말고 보고서에 "계약 변경 제안"으로 적는다.

설계: `docs/superpowers/specs/2026-11-17-seoul-ar-stage-design.md`. 계획: `docs/superpowers/plans/2026-11-17-seoul-ar-stage.md`.

## 0. 공통

- 작업 위치: 워크트리 `~/claude-lab/seoul-ar-stage` (브랜치 `feat/stage`). 본체 저장소 `~/claude-lab/seoul-ar`는 다른 세션의 작업 공간이니 읽기만.
- Bash 명령문에 `http://`, `https://`, `wss://`를 쓰지 않는다(세션 가드). 파일 내용에는 써도 된다.
- 프론트 테스트 `cd frontend && npx vitest run <pattern>`(node 환경, `src/**/*.test.ts`). 도구 테스트 `cd tools && npx vitest run <pattern>`(`**/*.test.mjs`).
- 타입 확인: 다른 작업자가 동시에 파일을 쓰고 있으므로 `npx tsc --noEmit -p frontend` 출력 중 **자기 파일의 오류만** 0이면 된다.
- 순수 모듈은 DOM·three·MediaPipe를 import하지 않는다(테스트 가능성). DOM이 필요한 부분은 주입.
- 화면 문자열은 한국어. 글꼴은 본체 `FONT_STACK`. ALL CAPS 금지.
- 공유 타입은 `frontend/src/stage/types.ts`(컨트롤러가 미리 만듦, 작업자는 수정 금지, 1절 그대로).
- 작업자는 `git add`/`git commit` 하지 않는다. 의존성 추가 금지(필요한 것은 컨트롤러가 미리 설치함: 프론트 `@mediapipe/tasks-vision@1.2.3`, 도구 `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-polly`).

## 1. 공유 타입 (`frontend/src/stage/types.ts`)

```ts
import type { Metric } from "../data/types";
export type Vec3 = [number, number, number];
export type GestureName = "None" | "Closed_Fist" | "Open_Palm" | "Pointing_Up" | "Thumb_Down" | "Thumb_Up" | "Victory" | "ILoveYou";
export interface HandObs { landmarks: Vec3[]; gesture: GestureName; score: number; handedness: "Left" | "Right" | "Unknown"; }
export interface HandFrame { t: number; hands: HandObs[]; }          // t: ms(performance.now), landmarks 21개, x·y∈[0,1] 영상 좌표(거울 아님)
export interface Point { x: number; y: number; }                     // 화면 정규 좌표 [0,1], 왼쪽 위 원점
export type GestureEvent = { type: "grab" } | { type: "release" } | { type: "spread" } | { type: "victory" };
export interface GestureOutput { primary: number | null; events: GestureEvent[]; handCount: number; }

export type StageMode = "map" | "spread";
export type InputMode = "hands" | "mouse";
export type VoteMethod = "camera" | "manual";
export type VotePhase = "prompt" | "counting" | "awaitManual" | "review" | "result";
export type VoteSource = "camera" | "manual" | null;
export interface VoteState {
  round: number; candidates: [string, string, string]; index: 0 | 1 | 2; phase: VotePhase; method: VoteMethod;
  counts: [number | null, number | null, number | null]; sources: [VoteSource, VoteSource, VoteSource];
  reviewEdited: boolean; winner: string | null; allZero: boolean; endsAt: number | null;
}
export interface StageState {
  mode: StageMode; hover: string | null; lifted: string | null; focus: string | null;
  input: InputMode; vote: VoteState | null; month: string; metric: Metric; round: number;
}
export type StageEvent =
  | { type: "hover"; gu: string | null }
  | { type: "grab" } | { type: "release" } | { type: "spread" } | { type: "victory" }
  | { type: "voteStart"; candidates: [string, string, string]; now: number }
  | { type: "voteTick"; now: number; cameraCount: number | null }
  | { type: "voteSet"; index: number; n: number; now: number }
  | { type: "voteMethod"; method: VoteMethod; now: number }
  | { type: "voteConfirm"; now: number }
  | { type: "voteCancel" }
  | { type: "setInput"; input: InputMode; now: number }
  | { type: "month"; month: string }
  | { type: "metric"; metric: Metric };
export type Effect =
  | { type: "scene.layout"; mode: StageMode }
  | { type: "scene.lift"; gu: string | null }
  | { type: "scene.focus"; gu: string | null }
  | { type: "scene.hover"; gu: string | null }
  | { type: "scene.data" }                                   // month/metric 바뀜: 요약·focus 다시 그림
  | { type: "narrate"; id: string; interrupt: boolean; protect: boolean }
  | { type: "counter.reset" }
  | { type: "publish.state" }                                // 본체 StateMessage(month, focus→gu, metric)
  | { type: "publish.stage" }                                // StageMessage(mode, lifted)
  | { type: "publish.vote" };                                // VoteMessage(result)
export const VOTE_MAX = 6;
export const VOTE_TIMING = { promptMs: 1500, countMs: 5000, manualAdvanceMs: 1000, reviewMs: 3000, resultMs: 6000 } as const;
```

## 2. 손 인식 (`frontend/src/stage/hands/`)

### 2.1 `cursor.ts`
```ts
export interface OneEuro { filter(x: number, tMs: number): number; reset(): void; }
export function createOneEuro(opts?: { minCutoff?: number; beta?: number; dCutoff?: number }): OneEuro; // 기본 1.0, 0.02, 1.0
export function palmCenter(lm: Vec3[]): Point;                       // 랜드마크 0,5,9,13,17의 x,y 평균
export function mapToScreen(p: Point, opts?: { mirror?: boolean; margin?: number }): Point;
// mirror 기본 true: x → 1-x. margin 기본 0.1: v' = (v - margin)/(1 - 2*margin), [0,1]로 자름
export interface CursorMapper { map(lm: Vec3[], tMs: number): Point; reset(): void; }
export function createCursorMapper(opts?: { mirror?: boolean; margin?: number; minCutoff?: number; beta?: number }): CursorMapper;
export function toNdc(p: Point): { x: number; y: number };          // x*2-1, -(y*2-1)
```

### 2.2 `gestureMachine.ts`
```ts
export interface GestureConfig { minScore: number; confirmFrames: number; cooldownMs: number; releaseAfterMs: number; }
export const DEFAULT_GESTURE_CONFIG: GestureConfig;                  // { 0.6, 6, 800, 300 }
export interface GestureMachine { push(frame: HandFrame, ctx: { voting: boolean }): GestureOutput; reset(): void; readonly fist: boolean; }
export function createGestureMachine(cfg?: Partial<GestureConfig>): GestureMachine;
```
규칙(순서대로 적용):
- 주 손(primary): 직전 주 손이 있으면 손목(랜드마크 0) 거리가 가장 가까운 손, 없으면 손바닥 폭(랜드마크 5↔17 거리)이 가장 큰 손. 손이 없으면 null. `handCount = min(hands.length, VOTE_MAX)`.
- "확정" = 해당 조건이 `confirmFrames` 연속 프레임 참.
- `grab`: fist=false이고 주 손이 `Closed_Fist`·score≥minScore로 확정, 쿨다운 지남 → fist=true.
- `release`: fist=true이고 (주 손이 `Closed_Fist`·≥minScore가 아님이 확정) 또는 (손 없음이 `releaseAfterMs` 이상) → fist=false. 쿨다운 무시, 발생 시 쿨다운 시작.
- `spread`: fist=false, 손이 정확히 2개, 둘 다 `Open_Palm`·≥minScore로 확정, 쿨다운 지남 → 한 번. 그 뒤 "둘 다 편 손이 아님"이 한 프레임이라도 나와야 다시 발생 가능(래치).
- `victory`: fist=false, 주 손 `Victory`·≥minScore 확정, 쿨다운 지남 → 한 번, 래치(제스처가 바뀌어야 재발생).
- 한 손 `Open_Palm`은 이벤트 없음.
- `ctx.voting`이 true면 이벤트를 내지 않는다. 투표 시작 시 fist가 true였다면 조용히 false로(이벤트 없음).
- grab/spread/victory 발생 후 `cooldownMs` 동안 grab/spread/victory 없음.

### 2.3 `voteCounter.ts`
```ts
export interface VoteCounter { push(tMs: number, handCount: number): void; result(): number | null; reset(): void; }
export function createVoteCounter(opts?: { stableMs?: number; max?: number }): VoteCounter; // 기본 500, VOTE_MAX
```
같은 개수가 `stableMs` 이상 이어진 구간들 중 최댓값(상한 max). 그런 구간이 하나도 없으면 null. 0개가 500ms 이어지면 0.

### 2.4 `recognizer.ts`
```ts
export const MODEL_PATH = "/models/gesture_recognizer.task";
export const WASM_PATH = "/mediapipe/wasm";
export type HandSourceError = "no-camera" | "denied" | "model-missing" | "wasm-failed" | "unsupported";
export interface HandSource {
  readonly video: HTMLVideoElement; readonly fps: number; readonly loadMs: number | null; readonly delegate: "GPU" | "CPU";
  onFrame(cb: (f: HandFrame) => void): () => void; stop(): void;
}
export interface RecognizerResultLike {
  gestures: { categoryName: string; score: number }[][];
  landmarks: { x: number; y: number; z: number }[][];
  handedness?: { categoryName: string; score: number }[][]; handednesses?: { categoryName: string; score: number }[][];
}
export function toHandFrame(result: RecognizerResultLike, t: number): HandFrame; // 순수. 모르는 제스처 이름은 "None"
export interface HandSourceDeps {
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  loadVision?: () => Promise<typeof import("@mediapipe/tasks-vision")>;
  modelExists?: () => Promise<boolean>;                              // 기본: fetch(MODEL_PATH, {method:"HEAD"}).ok
}
export async function startHandSource(deps?: HandSourceDeps): Promise<{ ok: true; source: HandSource } | { ok: false; reason: HandSourceError }>;
```
- 카메라 `{ video: { width: 1280, height: 720, facingMode: "user" }, audio: false }`. NotAllowedError → "denied", NotFoundError·mediaDevices 없음 → "no-camera".
- `GestureRecognizer.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL_PATH, delegate }, runningMode: "VIDEO", numHands: VOTE_MAX })`, GPU 먼저 실패 시 CPU. 둘 다 실패 → "wasm-failed". 모델 없음 → "model-missing".
- 프레임: `video.requestVideoFrameCallback`(없으면 rAF), `recognizeForVideo(video, performance.now())` → `toHandFrame`.
- MediaPipe는 이 파일에서만 동적 import한다.

## 3. 무대 상태 (`frontend/src/stage/`)

### 3.1 `stageState.ts`
```ts
export function initialStageState(month: string, input: InputMode): StageState; // mode map, 나머지 null/false, metric "price", round 0
export function reduceStage(s: StageState, e: StageEvent): StageState;          // 순수, 불변
export function defaultCandidates(summary: Record<string, Stat>, metric: Metric, gus: readonly string[]): [string, string, string];
// 지표 내림차순(값 null 제외, 동률 GU_ORDER 순) 1위, 13위, 25위(유효 구가 25 미만이면 첫째, 가운데 floor((k-1)/2), 마지막)
export function parseVoteParam(hash: string, gus: readonly string[]): string[] | null;
// "#/stage?vote=강남구,마포구,노원구" → 유효 이름(중복 제거) 배열, 없으면 null. 3개 미만이면 호출자가 기본값으로 채움
export function winnerOf(v: VoteState): { winner: string; allZero: boolean };   // null은 0으로, 동률이면 앞 후보
```
규칙(설계 5.3 그대로):
- `hover`: hover 갱신(투표 중에도).
- 투표가 진행 중(vote != null이고 phase != "result")이면 grab/release/spread/victory 무시. phase "result"에서 grab/spread/victory가 오면 vote=null로 지운 뒤 적용.
- `grab`: hover가 있으면 lifted=hover. `release`: lifted가 있으면 focus=lifted, lifted=null, mode="map". `spread`: lifted가 있으면 무시, 아니면 mode 토글. `victory`: focus=null, lifted=null, mode="map".
- `voteStart`: 진행 중 투표가 있으면 무시. round+1, lifted=null, vote={ candidates, index 0, phase "prompt", method: input==="mouse" ? "manual" : "camera", counts·sources null, endsAt now+promptMs }.
- `voteTick(now, cameraCount)`:
  - prompt, now≥endsAt → counting, endsAt = method camera ? now+countMs : null.
  - counting(camera), now≥endsAt → sources[index]==="manual"이면 그 값 유지; 아니면 cameraCount가 null이 아니면 counts=cameraCount, sources "camera", 다음으로; null이면 phase awaitManual, endsAt null.
  - counting/awaitManual에서 endsAt이 있고(직접 선택 후 대기) now≥endsAt → 다음으로.
  - "다음으로": index<2면 index+1, phase prompt, endsAt now+promptMs. index==2면 phase review, endsAt now+reviewMs, reviewEdited false.
  - review, reviewEdited false, now≥endsAt → result(아래 확정과 같음).
  - result, now≥endsAt → vote=null.
- `voteSet(index, n, now)`: n이 0~VOTE_MAX 정수가 아니면 무시. review가 아니면 index ≤ 현재 index만, review면 0~2 모두. counts[index]=n, sources[index]="manual". review면 reviewEdited=true, endsAt=null. 현재 후보이고 phase가 awaitManual이거나 method manual이면 endsAt=now+manualAdvanceMs.
- `voteMethod(method, now)`: method 갱신. counting 중 camera→manual이면 endsAt=null, manual→camera면 endsAt=now+countMs.
- `voteConfirm(now)`: review에서만 → winnerOf → phase result, winner, allZero, endsAt now+resultMs, focus=winner, lifted=null, mode="map".
- `voteCancel`: vote=null.
- `setInput(input, now)`: input 갱신. mouse가 되면 진행 중 투표의 method를 manual로(counting이면 endsAt=null). lifted가 있으면 손 모드에서 마우스로 바뀔 때 lifted=null(focus 불변).
- `month`, `metric`: 갱신.

### 3.2 `effects.ts`
```ts
export function diffEffects(prev: StageState, next: StageState): Effect[];
export const NARRATION_IDS: {
  hello: "stage-hello"; spread: "spread-intro"; mapBack: "map-back"; voteIntro: "vote-intro";
  gu(month: string, gu: string): string;            // `gu-${month}-${gu}`
  votePrompt(gu: string): string;                   // `vote-prompt-${gu}`
  voteResult(gu: string, n: number): string;        // `vote-result-${gu}-${n}` (n 1~6)
  voteNone(gu: string): string;                     // `vote-none-${gu}`
};
```
출력 순서: scene.layout → scene.lift → scene.focus → scene.hover → scene.data → counter.reset → narrate → publish.state → publish.stage → publish.vote. 같은 타입은 한 번만.
- mode 바뀜 → scene.layout, publish.stage, narrate(spread면 spread-intro, map이면 map-back; 단 이번 변화가 투표 확정이나 release로 생긴 map 복귀면 map-back 생략), interrupt true.
- lifted 바뀜 → scene.lift(next.lifted), publish.stage. null이 아닌 값이 되면 narrate gu(month, lifted) interrupt true.
- focus 바뀜 → scene.focus, publish.state.
- hover 바뀜 → scene.hover.
- month 또는 metric 바뀜 → scene.data, publish.state.
- vote: 새 round 시작 → narrate vote-intro(interrupt true, protect true). prompt 단계 진입(index 바뀜 포함) → narrate votePrompt(candidates[index]) (interrupt false, protect true). counting 진입 → counter.reset. result 진입 → narrate (allZero ? voteNone(winner) : voteResult(winner, counts[winnerIndex])) interrupt true, 이어서 gu(month, winner) interrupt false, 그리고 publish.vote. 그 외 투표 단계 변화는 publish 없음.

### 3.3 `keys.ts`
```ts
export type UiAction = "toggleInput" | "mute" | "preview" | "diag" | "hints" | "monthPrev" | "monthNext" | "voteToggle" | "rowUp" | "rowDown";
export type KeyResult = { kind: "event"; event: StageEvent } | { kind: "ui"; action: UiAction } | null;
export function keyToAction(key: string, s: StageState, ui: { reviewRow: number; now: number }): KeyResult;
export interface PointerHandlers { move(p: Point): void; down(): void; up(): void; leave(): void; }
export function attachPointer(el: HTMLElement, h: PointerHandlers): () => void; // pointermove/down/up/leave, el 사각형 기준 정규 좌표
```
키: `" "`→spread, `"Escape"`→victory, `"0"`~`"6"`→투표 중이면 voteSet(index = phase review ? ui.reviewRow : vote.index), 아니면 null. `"Enter"`→review면 voteConfirm. `"n"|"N"`→투표 중이면 voteMethod 토글. `"v"|"V"`→ui voteToggle. `"g"|"G"`→ui toggleInput. `"m"`→mute, `"c"`→preview, `"d"`→diag, `"h"`→hints, `"ArrowLeft"`→monthPrev, `"ArrowRight"`→monthNext, `"ArrowUp"`/`"ArrowDown"`→review면 rowUp/rowDown, `"p"|"P"`→metric 토글 이벤트. 대소문자 모두.

## 4. 실시간 (`frontend/src/stage/net/`)

### 4.1 `messages.ts`
```ts
export const STAGE_CHANNEL = "/seoul/stage";
export interface StageMessage { v: 1; type: "stage"; mode: StageMode; lifted: string | null; ts: number; }
export interface VoteMessage { v: 1; type: "vote"; round: number; phase: "counting" | "result"; candidates: string[]; counts: (number | null)[]; winner: string | null; ts: number; }
export type StageChannelMessage = StageMessage | VoteMessage;
export const ALLOWED_KEYS: { stage: readonly string[]; vote: readonly string[] };
export function isStageMessage(x: unknown): x is StageMessage;      // gu 이름은 GU_ORDER 안, ts 유한수
export function isVoteMessage(x: unknown): x is VoteMessage;        // candidates·counts 길이 3, counts 0~6 정수 또는 null
export function isStageChannelMessage(x: unknown): x is StageChannelMessage;
export function assertPublishable(x: unknown): asserts x is StageChannelMessage; // 허용 키 밖이 있거나 검사 실패면 throw
export function toStageMessage(s: StageState, ts: number): StageMessage;
export function toVoteMessage(v: VoteState, ts: number): VoteMessage; // phase result → "result", 그 외 "counting"
```

### 4.2 `stageChannel.ts`
```ts
export interface StageChannel {
  connect(): Promise<void>; subscribe(h: (m: StageChannelMessage) => void): () => void;
  publish(m: StageChannelMessage): Promise<void>;                    // assertPublishable 먼저
  readonly status: ConnStatus; onStatus(cb: (s: ConnStatus) => void): () => void; close(): void;
}
export function createAppSyncStageChannel(cfg: EventsConfig): StageChannel; // aws-amplify events, 채널 STAGE_CHANNEL, 본체 appsync.ts와 같은 Amplify.configure(재호출 무해)
export function createMockStageChannel(opts?: { channel?: () => BroadcastLike | null }): StageChannel; // BroadcastChannel("seoul-ar-stage")
export function makeStageChannel(events: EventsConfig | null): StageChannel; // events 있으면 AppSync(생성 실패 시 mock), 없으면 mock
```
본체 `frontend/src/realtime/appsync.ts`, `mock.ts`는 수정하지 않는다(다른 세션 소유). 재시도·타임아웃 상수는 본체와 같은 값(8000, 3000~30000).

## 5. 해설

### 5.1 재생 (`frontend/src/stage/narrator.ts`)
```ts
export interface NarrationItem { file: string; caption: string; hash?: string; ms?: number; }
export interface NarrationManifest { v: 1; voice: string; engine: string; items: Record<string, NarrationItem>; }
export interface AudioLike { src: string; muted: boolean; play(): Promise<void>; pause(): void; onended: (() => void) | null; onerror: (() => void) | null; }
export interface Narrator {
  say(id: string, opts?: { interrupt?: boolean; protect?: boolean }): void; stop(): void;
  setMuted(m: boolean): void; readonly muted: boolean;
  onCaption(cb: (text: string | null) => void): () => void;
  unlock(): Promise<void>;                                            // 사용자 제스처 안에서 무음 재생으로 오토플레이 해제
}
export function createNarrator(manifest: NarrationManifest | null, deps: { createAudio(): AudioLike; base?: string; timers?: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void } }): Narrator;
export async function loadManifest(fetchImpl?: typeof fetch): Promise<NarrationManifest | null>; // "/narration/manifest.json", 실패·형식 오류면 null
```
- base 기본 `"/narration/"`. 재생 파일 = base + item.file.
- interrupt true: 현재가 protect면 현재 뒤 맨 앞에 끼움, 아니면 현재를 멈추고 큐를 비운 뒤 즉시 재생. interrupt false: 큐 끝에 추가.
- 자막: 재생 시작 시 caption, 끝난 뒤 1500ms에 null. 오디오 오류(파일 없음)면 caption을 `max(item.ms ?? 0, 2500)`ms 보인 뒤 다음으로. manifest에 없는 id는 건너뜀(console.warn 한 번).
- muted여도 자막과 진행은 같다.

### 5.2 해설 id와 문장 (`tools/narration/`)
- id 형식은 3.2 `NARRATION_IDS`와 글자 하나까지 같다. 득표 결과는 n 1~6만(0표는 vote-none).
- 문장 항목 `{ id, caption, speech }`. caption은 자막용(아라비아 숫자, "2,890만 원"), speech는 Polly 낭독용(득표 수는 고유어: 한·두·세·네·다섯·여섯 표).
- 템플릿(고정 문구):
  - `stage-hello`: "무대를 시작합니다. 손을 들어 서울을 움직여 보세요."
  - `spread-intro`: "스물다섯 개 구를 ㎡당 가격순으로 펼쳤습니다. 왼쪽이 가장 비쌉니다." (caption은 "25개 구를 ㎡당 가격순으로 펼쳤습니다. 왼쪽이 가장 비쌉니다.", speech의 ㎡는 "제곱미터")
  - `map-back`: "다시 지도로 돌아왔습니다."
  - `vote-intro`: "투표를 시작합니다. 보고 싶은 구에 손을 들어 주세요."
  - `vote-prompt-{gu}`: "{gu} 보고 싶은 분, 손 들어 주세요."
  - `vote-result-{gu}-{n}`: caption "{n}표로 {gu}가 뽑혔습니다.", speech "{고유어} 표로 {gu}가 뽑혔습니다."
  - `vote-none-{gu}`: "아무도 손을 들지 않아 {gu}로 갑니다."
- 구 해설 `gu-{month}-{gu}`: Bedrock이 사실표로 쓴다(5.3).

### 5.3 도구 시그니처
```js
// tools/narration/ids.mjs
export const NARRATION_IDS; // 3.2와 같은 구조(JS)
export const NATIVE_COUNT = ["", "한", "두", "세", "네", "다섯", "여섯"];
// tools/narration/facts.mjs
export function buildFacts(index, guDataByName, month); // → Facts[] (GU_ORDER 순)
// Facts = { gu, month, n, cancelled, medPerM2, rankPrice, maxAmt, topDong, topDongMedPerM2, totalGus: 25 }
// rankPrice: medPerM2 내림차순 1부터(null이면 null). topDong: dongs 중 n≥3인 것의 medPerM2 최대(없으면 n 최대, 그것도 없으면 null)
// tools/narration/templates.mjs
export function templateLines(gus, month); // → { id, caption, speech }[] : 고정 4 + prompt 25 + result 150 + none 25 = 204
// tools/narration/write.mjs  (Bedrock)
export const MODEL_ID = "global.anthropic.claude-sonnet-5-5";
export function buildPrompt(facts);                 // 한국어, 규칙 5.4, JSON {"caption","speech"}만 출력하라고 지시
export function extractText(converseResponse);      // output.message.content 중 text 있는 첫 블록(reasoningContent 건너뜀)
export function parseScript(text);                  // 코드펜스 허용, {caption, speech} 문자열 둘 다 있어야
export function allowedNumbers(facts);              // 자막에 허용되는 숫자 문자열 집합(설계 5.6)
export function validateScript(facts, script);      // → { ok, errors: string[] }
export function fallbackScript(facts);              // 템플릿 해설(데이터 없음 포함)
export async function writeScripts(factsList, { client, modelId, retries = 2, log });
// → { items: { [id]: { caption, speech, source: "bedrock" | "template" } }, failures: string[] }
// CLI: node tools/narration/write.mjs --data frontend/public/data --month 202611 --out tools/narration/scripts.json
// tools/narration/synth.mjs  (Polly)
export function speechHash(text, voice, engine);    // sha1 hex 앞 16자
export function buildManifest(lines, { voice, engine, hashes }); // → NarrationManifest (5.1), file = `${id}.mp3`
export async function synthAll(lines, { client, outDir, voice = "Seoyeon", engine = "generative", fallbackEngine = "neural", previous, log });
// previous manifest의 hash가 같고 파일이 있으면 건너뜀. → { manifest, synthesized, skipped, failed }
// CLI: node tools/narration/synth.mjs --scripts tools/narration/scripts.json --data frontend/public/data --month 202611 --out frontend/public/narration
```
- 5.4 문장 규칙: 존댓말 두 문장, caption 90자 이내, 사실표 숫자만, 건물명·지번·본번·부번 금지, 투자 권유·과장("폭등", "대박", "꼭 사야") 금지, 데이터 없음(n 0)이면 "이번 달 거래가 없었습니다" 취지.
- `allowedNumbers`: n, cancelled, rankPrice, totalGus(25), medPerM2·topDongMedPerM2(쉼표 형식과 원형), maxAmt를 억 단위 소수 첫째 자리(예 52.6)와 원형, 월 표기(2026, 11). 자막 속 숫자 토큰(`\d[\d,]*(\.\d+)?`)이 전부 이 집합에 있어야 ok.
- 실제 호출은 `@aws-sdk/client-bedrock-runtime`의 `ConverseCommand`, `@aws-sdk/client-polly`의 `SynthesizeSpeechCommand`(`OutputFormat: "mp3"`, `LanguageCode: "ko-KR"`, `AudioStream.transformToByteArray()`). region us-east-1. 테스트는 가짜 client(`send`)를 주입한다.

## 6. 3D 씬 확장 (`frontend/src/scene/`)

### 6.1 `spreadLayout.ts` (순수)
```ts
export interface SpreadSlot { gu: string; x: number; z: number; height: number; rank: number | null; value: number | null; }
export const SPREAD_RADIUS = 0.9; export const SPREAD_ANGLE_DEG = 50; export const SPREAD_MIN_H = 0.02; export const SPREAD_MAX_H = 0.30;
export function spreadLayout(summary: Record<string, Stat>, metric: Metric, gus: readonly string[]): SpreadSlot[];
```
정렬: 값(price→medPerM2, count→n) 내림차순, 동률·null은 gus 순서, null은 뒤(rank null). i번째(0~k-1, k=gus.length) θ = -50° + 100°·i/(k-1). x = R·sinθ, z = R·(1 - cosθ). height = MIN + (MAX-MIN)·value/max(값들), null·max≤0이면 MIN. 왼쪽(x<0)이 1위.

### 6.2 `seoulScene.ts` 추가 메서드 (기존 시그니처 불변)
```ts
// SeoulScene 인터페이스에 추가
setHover(gu: string | null): void;       // 테두리 밝게 + y +0.01
lift(gu: string | null): void;           // y LIFT_Y까지 상승, 그 아래 반투명 그림자 원판, 나머지 구 guDim. null이면 내려놓음
setLayout(mode: StageMode, summary: Record<string, Stat>, metric: Metric): void; // spread: 각 구 메시 그룹을 centroid→slot(x,z)로 이동, 높이 slot.height로 스케일, 순위·이름 라벨. map: 원위치. LAYOUT_SECONDS 보간(reducedMotion이면 즉시)
pick(ndcX: number, ndcY: number, camera: Camera): string | null; // 구 메시만 레이캐스트(윤곽선·라벨·막대 제외)
export const LIFT_Y = 0.12; export const LAYOUT_SECONDS = 0.8;
```
spread 중 focus(gu)가 오면 map으로 돌아간 뒤 적용(호출자가 setLayout("map") 먼저 부름).

## 7. 무대 렌더러 (`frontend/src/stage/stageRenderer.ts`)
```ts
export interface CameraPose { pos: Vec3; target: Vec3; fov: number; }
export const MAP_POSE: CameraPose;      // { pos: [0, 1.05, 0.75], target: [0, 0, 0.02], fov: 40 }  약 55° 내려다봄
export const SPREAD_POSE: CameraPose;   // { pos: [0, 0.55, 1.35], target: [0, 0.12, 0.1], fov: 40 }
export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose; // t 0~1, easeOutCubic 적용은 호출자
export interface StageRenderer {
  world: import("three").Scene; camera: import("three").PerspectiveCamera; canvas: HTMLCanvasElement;
  setMode(mode: StageMode, instant?: boolean): void;  // LAYOUT_SECONDS 동안 포즈 보간
  onFrame(cb: (dt: number) => void): () => void; resize(): void; dispose(): void;
}
export function createStageRenderer(container: HTMLElement, opts: { reducedMotion: boolean }): StageRenderer | null; // WebGL 없으면 null
```
조명·안개는 본체 orbitView와 같은 톤. 자동 회전 없음.

## 8. 무대 화면 조각 (`frontend/src/stage/ui/`)

모두 HTML 문자열을 돌려주는 순수 함수(본체 `ui/html.ts`의 이스케이프 사용). DOM 연결은 stageView.

```ts
// votePanel.ts + vote.css
export function renderVotePanel(v: VoteState, ui: { reviewRow: number; now: number }): string;
// 후보 줄 3개: 구 이름, 막대(counts/VOTE_MAX), "{n}손"/"?"/"—", 출처 표시("카메라"/"직접"), 숫자 버튼 0~6(data-vote-set="{index}:{n}", 선택값 aria-pressed="true").
// 아직 안 온 후보 줄은 버튼 비활성(review 제외). 상단: prompt/counting이면 "{gu} 보고 싶은 분, 손 들어 주세요" + 남은 초, awaitManual이면 "손이 인식되지 않았어요 · 개수를 골라 주세요",
// review면 "집계 확인 · 고칠 곳이 있으면 개수를 누르세요" + [확정 Enter](data-vote-confirm), result면 "{winner} 선정". 하단 방식 토글(data-vote-method="camera|manual", aria-pressed).
// hud.ts + hud.css
export function renderTopBar(s: StageState, o: { conn: ConnStatus; publishFailed: boolean; monthLabel: string }): string; // "서울이 선다 · 무대", 월·지표, 연결("실시간 연결"/"연결 중"/"오프라인 모드"/빨간 "발행 실패")
export function renderHints(s: StageState): string;   // 손 모드: "주먹: 들어올리기 · 두 손 펴기: 가격순 펼치기 · 브이: 전체 보기 · V: 투표 · M: 음소거", 마우스 모드: "누르고 있기: 들어올리기 · 스페이스: 가격순 펼치기 · Esc: 전체 보기 · V: 투표 · G: 손 모드"
export function renderStart(o: { modelReady: boolean; reason: HandSourceError | null }): string; // "무대 시작"(data-start="hands") + "마우스로 시작"(data-start="mouse"), 모델 없으면 안내 한 줄
export function renderCaption(text: string | null): string;
// overlay.ts + overlay.css
export type PreviewMode = "video" | "skeleton" | "hidden";
export function nextPreviewMode(m: PreviewMode): PreviewMode;         // video → skeleton → hidden → video
export const HAND_CONNECTIONS: readonly [number, number][];           // MediaPipe 21점 연결 21개
export interface Ctx2DLike { clearRect(...a: number[]): void; beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; stroke(): void; arc(x: number, y: number, r: number, a: number, b: number): void; fill(): void; strokeStyle: unknown; fillStyle: unknown; lineWidth: number; }
export function drawSkeleton(ctx: Ctx2DLike, frame: HandFrame, w: number, h: number, mirror: boolean): void;
export function cursorClass(o: { visible: boolean; fist: boolean; hovering: boolean }): string; // "stage-cursor" + is-hidden/is-fist/is-hover
export function renderDiag(d: { fps: number; hands: number; gesture: string; score: number; cursor: Point | null; loadMs: number | null; delegate: string | null; input: InputMode }): string;
```
디자인: 본체 토큰(`#0b1020`, 램프, FONT_STACK), 자막 40px/600, 상단 22px, 안내 18px, 대비 4.5:1, 카드·같은 그림자 반복·ALL CAPS·페이드인 금지. 커서 지름 56px 링.

## 9. 조립 (`frontend/src/views/stageView.ts`, 라우트)

```ts
export function mountStageView(root: HTMLElement, ctx: ViewContext): () => void;
```
- `ViewContext`에 `stageChannel: StageChannel` 추가(`views/types.ts`), `main.ts`가 `makeStageChannel(config.events)`로 만들어 connect.
- 라우트 `"stage"` 추가(`router.ts` ROUTES, Route 타입), `main.ts` TITLES "무대 | 서울이 선다", 뷰 등록은 `import("./views/stageView")` 동적 로드(관객 번들에 MediaPipe 미포함). `realtime.subscribe` 분기는 host와 stage 모두 원격 무시.
- 호스트 화면에 "무대 열기" 링크(`#/stage`) 한 줄.
- 흐름: 시작 화면 → (손) startHandSource → 실패면 토스트 + 마우스 → 프레임마다 gestureMachine.push → primary로 cursorMapper → renderer 기준 pick → hover 이벤트(바뀔 때만) → 제스처 이벤트 → reduceStage → diffEffects → 실행. 투표 중에는 voteCounter.push(t, handCount)와 250ms 간격 voteTick(now, counter.result()).
- publish.state → 본체 `ctx.realtime.publish({v:1,type:"state",month,gu:focus,metric,ts})`, publish.stage/vote → `ctx.stageChannel.publish`. 실패하면 publishFailed=true(상단 빨간 표시), 성공하면 false. 10초마다 state·stage 재발행(본체 호스트와 같은 하트비트).
- 데이터: 시작 시 `ctx.index.summary[month]`로 overview, focus 바뀌면 `ctx.loadGu` 후 scene.focus.
- 월 이동: index.months 안에서만(한 달뿐이면 아무 일 없음).

## 10. 뷰어 따라가기 (`frontend/src/views/`)

```ts
// frontend/src/views/stageFollow.ts
export interface StageFollowOptions {
  channel: StageChannel; store: Store; index: DataIndex;
  onLayout(mode: StageMode): void; onLift(gu: string | null): void; onVote(text: string): void;
}
export function bindStageFollow(o: StageFollowOptions): () => void;   // follow가 true일 때만 onLayout/onLift, VoteMessage result는 follow와 무관하게 onVote
export function voteLine(m: VoteMessage): string;                      // "투표 결과 강남구 2표 · 마포구 1표 · 노원구 0표"
```
- `orbitView.ts`: bindStageFollow 연결 → `city.setLayout(mode, index.summary[month], metric)`, `city.lift(gu)`, 바텀시트 위 한 줄 6초.
- `arView.ts`: StageMessage를 처음 받으면 "무대 진행 중 · 3D로 따라가기" 배너(탭 → `ctx.navigate("#/3d")`), 투표 결과 한 줄은 같음.
